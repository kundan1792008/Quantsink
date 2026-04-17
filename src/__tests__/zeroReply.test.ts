import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app';

const TEST_SECRET = process.env.QUANTMAIL_JWT_SECRET ?? 'test-secret';

function makeToken(overrides: Record<string, unknown> = {}) {
  return jwt.sign(
    { sub: 'user-1', email: 'test@example.com', biometricVerified: true, ...overrides },
    TEST_SECRET,
    { expiresIn: '1h' },
  );
}

// ---------------------------------------------------------------------------
// Zero-Reply Protocol
// ---------------------------------------------------------------------------

describe('Zero-Reply Protocol', () => {
  const token = makeToken();

  it('rejects POST /short/:id/reply with 405', async () => {
    const res = await request(app)
      .post('/api/v1/posts/short/some-post-id/reply')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'hello' });
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('ZERO_REPLY_VIOLATION');
  });

  it('rejects POST /short/:id/quote with 405', async () => {
    const res = await request(app)
      .post('/api/v1/posts/short/some-post-id/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'quoting' });
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('ZERO_REPLY_VIOLATION');
  });

  it('rejects POST /deep/:id/reply with 405', async () => {
    const res = await request(app)
      .post('/api/v1/posts/deep/some-post-id/reply')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'deep reply' });
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('ZERO_REPLY_VIOLATION');
  });

  it('rejects POST /interact with 405', async () => {
    const res = await request(app)
      .post('/api/v1/posts/interact')
      .set('Authorization', `Bearer ${token}`)
      .send({ interactionType: 'like', postId: 'abc' });
    expect(res.status).toBe(405);
    expect(res.body.error).toBe('ZERO_REPLY_VIOLATION');
  });

  it('rejects a short-post payload that contains replyTo field with 403', async () => {
    const res = await request(app)
      .post('/api/v1/posts/short')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'hello', replyTo: 'some-id' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ZERO_REPLY_VIOLATION');
    expect(res.body.fields).toContain('replyTo');
  });

  it('rejects a deep-post payload that contains quotedPost field with 403', async () => {
    const res = await request(app)
      .post('/api/v1/posts/deep')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Test', content: 'body', quotedPost: 'some-id' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ZERO_REPLY_VIOLATION');
    expect(res.body.fields).toContain('quotedPost');
  });
});
