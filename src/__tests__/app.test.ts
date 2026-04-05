import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app';

describe('GET /health', () => {
  it('returns 200 and service name', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('quantsink');
  });
});

describe('404 handler', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});

describe('Auth middleware', () => {
  it('rejects requests without Authorization header', async () => {
    const res = await request(app).get('/api/v1/posts/feed');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/authorization/i);
  });

  it('rejects requests with malformed token', async () => {
    const res = await request(app)
      .get('/api/v1/posts/feed')
      .set('Authorization', 'Bearer not-a-valid-jwt');
    expect(res.status).toBe(401);
  });

  it('rejects requests without biometricVerified flag', async () => {
    // Sign a JWT without biometricVerified=true
    const token = jwt.sign(
      { sub: 'user-1', email: 'test@example.com', biometricVerified: false },
      process.env.QUANTMAIL_JWT_SECRET ?? 'test-secret',
      { expiresIn: '1h' },
    );

    const res = await request(app)
      .get('/api/v1/posts/feed')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/biometric/i);
  });
});
