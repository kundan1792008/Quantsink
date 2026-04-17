import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app';

const JWT_SECRET = 'test-secret';
process.env.QUANTMAIL_JWT_SECRET = JWT_SECRET;

// ---------------------------------------------------------------------------
// Mock Prisma — no real database required
// ---------------------------------------------------------------------------
jest.mock('../lib/prisma', () => {
  const mockUser = {
    id:          'user-uuid-1',
    quantmailId: 'qm-user-1',
    email:       'broadcaster@example.com',
    displayName: 'Test Broadcaster',
    avatarUrl:   null,
  };

  const mockBroadcast = {
    id:                'bc-uuid-1',
    authorId:          'user-uuid-1',
    content:           'Test broadcast content',
    biometricHash:     'hash-abc',
    biometricVerified: true,
    viewCount:         0,
    deletedAt:         null,
    createdAt:         new Date('2025-01-01T12:00:00Z'),
    updatedAt:         new Date('2025-01-01T12:00:00Z'),
    author:            {
      id:          'user-uuid-1',
      displayName: 'Test Broadcaster',
      avatarUrl:   null,
    },
  };

  return {
    __esModule: true,
    default: {
      user: {
        upsert:             jest.fn().mockResolvedValue(mockUser),
        findUnique:         jest.fn().mockResolvedValue(mockUser),
        findUniqueOrThrow:  jest.fn().mockResolvedValue(mockUser),
      },
      broadcast: {
        create: jest.fn().mockResolvedValue(mockBroadcast),
        findMany: jest.fn().mockResolvedValue([mockBroadcast]),
        findFirst: jest.fn().mockResolvedValue(mockBroadcast),
        update:    jest.fn().mockResolvedValue({ ...mockBroadcast, deletedAt: new Date() }),
      },
      securityAuditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    },
  };
});

// Mock WebSocket push so it's a no-op in tests
jest.mock('../services/BroadcastWebSocket', () => ({
  pushBroadcast:           jest.fn(),
  getConnectedClientCount: jest.fn().mockReturnValue(0),
  attachWebSocketServer:   jest.fn(),
}));

import prisma from '../lib/prisma';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeToken(
  opts: { biometricVerified?: boolean; sub?: string; email?: string } = {},
) {
  return jwt.sign(
    {
      sub:               opts.sub  ?? 'qm-user-1',
      email:             opts.email ?? 'broadcaster@example.com',
      displayName:       'Test Broadcaster',
      biometricVerified: opts.biometricVerified ?? true,
    },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// ---------------------------------------------------------------------------
// Zero-Reply Guard — integration via the Express app
// ---------------------------------------------------------------------------
describe('Zero-Reply Protocol guard (integration)', () => {
  const validToken = makeToken();

  it('blocks POST /api/v1/broadcasts with replyTo field', async () => {
    const res = await request(app)
      .post('/api/v1/broadcasts')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ content: 'test', biometricHash: 'h', replyTo: 'bc-1' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ZERO_REPLY_PROTOCOL_ACTIVE');
  });

  it('blocks POST /api/v1/broadcasts with quoteTo field', async () => {
    const res = await request(app)
      .post('/api/v1/broadcasts')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ content: 'test', biometricHash: 'h', quoteTo: 'bc-2' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ZERO_REPLY_PROTOCOL_ACTIVE');
  });

  it('blocks POST /api/v1/broadcasts with reactTo field', async () => {
    const res = await request(app)
      .post('/api/v1/broadcasts')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ reactTo: 'bc-3' });

    expect(res.status).toBe(403);
  });

  it('blocks POST /api/v1/broadcasts with parentId field', async () => {
    const res = await request(app)
      .post('/api/v1/broadcasts')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ content: 'nested', biometricHash: 'h', parentId: 'root-1' });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/broadcasts
// ---------------------------------------------------------------------------
describe('POST /api/v1/broadcasts', () => {
  it('returns 401 without authorization header', async () => {
    const res = await request(app)
      .post('/api/v1/broadcasts')
      .send({ content: 'hello', biometricHash: 'hash' });

    expect(res.status).toBe(401);
  });

  it('returns 403 when biometricVerified is false', async () => {
    const token = makeToken({ biometricVerified: false });
    const res = await request(app)
      .post('/api/v1/broadcasts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'hello', biometricHash: 'hash' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/biometric/i);
  });

  it('returns 400 when content is missing', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/broadcasts')
      .set('Authorization', `Bearer ${token}`)
      .send({ biometricHash: 'hash' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('returns 400 when biometricHash is missing', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/broadcasts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'hello' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when content exceeds 2000 characters', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/broadcasts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'x'.repeat(2001), biometricHash: 'hash' });

    expect(res.status).toBe(400);
  });

  it('creates a broadcast and returns 201 with broadcast data', async () => {
    const token = makeToken();
    const res = await request(app)
      .post('/api/v1/broadcasts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'My first broadcast', biometricHash: 'hash-abc' });

    expect(res.status).toBe(201);
    expect(res.body.broadcast).toBeDefined();
    expect(res.body.broadcast.content).toBe('Test broadcast content');
    expect(res.body.broadcast.biometricVerified).toBe(true);
    expect(prisma.broadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content:           'My first broadcast',
          biometricHash:     'hash-abc',
          biometricVerified: true,
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/broadcasts
// ---------------------------------------------------------------------------
describe('GET /api/v1/broadcasts', () => {
  it('returns 401 without authorization header', async () => {
    const res = await request(app).get('/api/v1/broadcasts');
    expect(res.status).toBe(401);
  });

  it('returns 403 when biometricVerified is false', async () => {
    const token = makeToken({ biometricVerified: false });
    const res = await request(app)
      .get('/api/v1/broadcasts')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('returns paginated broadcasts with nextCursor and hasNextPage', async () => {
    const token = makeToken();
    const res = await request(app)
      .get('/api/v1/broadcasts')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.broadcasts)).toBe(true);
    expect(res.body).toHaveProperty('nextCursor');
    expect(res.body).toHaveProperty('hasNextPage');
  });

  it('passes cursor query param to prisma findMany', async () => {
    const token = makeToken();
    const validCursorUuid = '550e8400-e29b-41d4-a716-446655440000';
    await request(app)
      .get(`/api/v1/broadcasts?cursor=${validCursorUuid}`)
      .set('Authorization', `Bearer ${token}`);

    expect(prisma.broadcast.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: validCursorUuid },
        skip:   1,
      }),
    );
  });

  it('returns 400 for an invalid (non-UUID) cursor', async () => {
    const token = makeToken();
    const res = await request(app)
      .get('/api/v1/broadcasts?cursor=not-a-uuid')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it('includes author fields in each broadcast item', async () => {
    const token = makeToken();
    const res = await request(app)
      .get('/api/v1/broadcasts')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const first = res.body.broadcasts[0];
    expect(first.author).toBeDefined();
    expect(first.author.id).toBeDefined();
    expect(first.author.displayName).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/broadcasts/:id
// ---------------------------------------------------------------------------
describe('DELETE /api/v1/broadcasts/:id', () => {
  beforeEach(() => {
    // Reset mocks to defaults
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id:          'user-uuid-1',
      quantmailId: 'qm-user-1',
      email:       'broadcaster@example.com',
      displayName: 'Test Broadcaster',
    });
    (prisma.broadcast.findFirst as jest.Mock).mockResolvedValue({
      id:        'bc-uuid-1',
      authorId:  'user-uuid-1',
      deletedAt: null,
    });
  });

  it('returns 401 without authorization', async () => {
    const res = await request(app).delete('/api/v1/broadcasts/bc-uuid-1');
    expect(res.status).toBe(401);
  });

  it('returns 403 when biometricVerified is false', async () => {
    const token = makeToken({ biometricVerified: false });
    const res = await request(app)
      .delete('/api/v1/broadcasts/bc-uuid-1')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when broadcast does not exist', async () => {
    (prisma.broadcast.findFirst as jest.Mock).mockResolvedValueOnce(null);
    const token = makeToken();
    const res = await request(app)
      .delete('/api/v1/broadcasts/nonexistent-id')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when user does not exist', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    const token = makeToken();
    const res = await request(app)
      .delete('/api/v1/broadcasts/bc-uuid-1')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns 403 when a different user tries to delete', async () => {
    (prisma.broadcast.findFirst as jest.Mock).mockResolvedValueOnce({
      id:        'bc-uuid-1',
      authorId:  'other-user-uuid',   // different user
      deletedAt: null,
    });
    const token = makeToken();
    const res = await request(app)
      .delete('/api/v1/broadcasts/bc-uuid-1')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not the author/i);
  });

  it('soft-deletes the broadcast and returns 204', async () => {
    const token = makeToken();
    const res = await request(app)
      .delete('/api/v1/broadcasts/bc-uuid-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(prisma.broadcast.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bc-uuid-1' },
        data:  expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/ws/stats
// ---------------------------------------------------------------------------
describe('GET /api/v1/ws/stats', () => {
  it('returns connected client count', async () => {
    const res = await request(app).get('/api/v1/ws/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('connectedClients');
    expect(typeof res.body.connectedClients).toBe('number');
  });
});
