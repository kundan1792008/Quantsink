import { Request, Response, NextFunction } from 'express';
import { zeroReplyGuard } from '../middleware/zeroReplyGuard';

// ---------------------------------------------------------------------------
// Mock prisma so tests never need a real database
// ---------------------------------------------------------------------------
jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    securityAuditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
  },
}));

import prisma from '../lib/prisma';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeReq(
  method: string,
  body: Record<string, unknown> = {},
): Partial<Request> {
  return {
    method,
    body,
    path:    '/api/v1/broadcasts',
    ip:      '127.0.0.1',
    headers: { 'user-agent': 'jest/test' } as Record<string, string>,
  };
}

function makeRes(): { res: Partial<Response>; ctx: { statusCode: number | null; jsonBody: unknown } } {
  const ctx: { statusCode: number | null; jsonBody: unknown } = {
    statusCode: null,
    jsonBody:   null,
  };

  const res: Partial<Response> = {
    status: jest.fn().mockImplementation((code: number) => {
      ctx.statusCode = code;
      return res;
    }),
    json: jest.fn().mockImplementation((body: unknown) => {
      ctx.jsonBody = body;
      return res;
    }),
  } as unknown as Partial<Response>;

  return { res, ctx };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('zeroReplyGuard middleware', () => {
  let next: jest.Mock;

  beforeEach(() => {
    next = jest.fn();
    (prisma.securityAuditLog.create as jest.Mock).mockClear();
  });

  // ── Pass-through cases ───────────────────────────────────────────────────

  it('passes GET requests through without inspection', async () => {
    const req = makeReq('GET');
    const { res } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes DELETE requests through without inspection', async () => {
    const req = makeReq('DELETE');
    const { res } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes POST requests that contain no banned fields', async () => {
    const req = makeReq('POST', { content: 'Hello world', biometricHash: 'abc123' });
    const { res } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes PUT requests that contain no banned fields', async () => {
    const req = makeReq('PUT', { title: 'Updated title' });
    const { res } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes PATCH requests that contain no banned fields', async () => {
    const req = makeReq('PATCH', { viewCount: 42 });
    const { res } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes when body is undefined', async () => {
    const req = { ...makeReq('POST'), body: undefined };
    const { res } = makeRes();
    await zeroReplyGuard(req as unknown as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes when body is null', async () => {
    const req = { ...makeReq('POST'), body: null };
    const { res } = makeRes();
    await zeroReplyGuard(req as unknown as Request, res as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ── Block cases ──────────────────────────────────────────────────────────

  it('blocks POST with replyTo field and returns 403', async () => {
    const req = makeReq('POST', { content: 'hi', replyTo: 'msg-1' });
    const { res, ctx } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect((ctx.jsonBody as Record<string, string>).error).toBe('ZERO_REPLY_PROTOCOL_ACTIVE');
    expect(ctx.statusCode).toBe(403);
  });

  it('blocks POST with quoteTo field', async () => {
    const req = makeReq('POST', { content: 'quote this', quoteTo: 'post-99' });
    const { res } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('blocks POST with reactTo field', async () => {
    const req = makeReq('POST', { reactTo: 'broadcast-55', emoji: '❤️' });
    const { res } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('blocks POST with parentId field', async () => {
    const req = makeReq('POST', { content: 'nested', parentId: 'root-1' });
    const { res } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('blocks PUT with replyTo field', async () => {
    const req = makeReq('PUT', { replyTo: 'something' });
    const { res } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('blocks PATCH with parentId field', async () => {
    const req = makeReq('PATCH', { parentId: 'x' });
    const { res } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // ── Audit log cases ──────────────────────────────────────────────────────

  it('schedules a SecurityAuditLog entry for blocked requests', async () => {
    const req = makeReq('POST', { replyTo: 'broadcast-1' });
    const { res } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);

    // The log is fire-and-forget — give the microtask queue a tick
    await Promise.resolve();

    expect(prisma.securityAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attemptType: 'ZERO_REPLY_FIELD:replyTo',
        blocked:     true,
      }),
    });
  });

  it('does NOT create an audit log for allowed requests', async () => {
    const req = makeReq('POST', { content: 'clean broadcast', biometricHash: 'hash' });
    const { res } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);
    expect(prisma.securityAuditLog.create).not.toHaveBeenCalled();
  });

  it('still returns 403 even when audit log persistence fails', async () => {
    (prisma.securityAuditLog.create as jest.Mock).mockRejectedValueOnce(
      new Error('DB down'),
    );
    const req = makeReq('POST', { replyTo: 'x' });
    const { res } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  // ── Response body ────────────────────────────────────────────────────────

  it('response body contains exactly { error: "ZERO_REPLY_PROTOCOL_ACTIVE" }', async () => {
    const req = makeReq('POST', { quoteTo: 'broadcast-2' });
    const { res } = makeRes();
    await zeroReplyGuard(req as Request, res as Response, next as NextFunction);
    expect(res.json).toHaveBeenCalledWith({ error: 'ZERO_REPLY_PROTOCOL_ACTIVE' });
  });
});
