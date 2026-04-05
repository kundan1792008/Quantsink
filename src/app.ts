import express from 'express';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import logger from './lib/logger';
import postsRouter from './routes/posts';
import connectionsRouter from './routes/connections';
import dmsRouter from './routes/dms';
import { errorHandler } from './middleware/errorHandler';

const app = express();

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(pinoHttp({ logger }));

// Rate limiting — applied globally to all API routes
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Stricter limit for write operations (DMs, posts, connections)
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'quantsink', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// API routes  v1
// ---------------------------------------------------------------------------
app.use('/api/v1/posts',       apiLimiter, postsRouter);
app.use('/api/v1/connections', writeLimiter, connectionsRouter);
app.use('/api/v1/dms',         writeLimiter, dmsRouter);

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Central error handler (must be last)
// ---------------------------------------------------------------------------
app.use(errorHandler);

export default app;
