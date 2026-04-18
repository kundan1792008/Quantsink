import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import logger from '../lib/logger';

/**
 * Fields that are banned under the Zero-Reply Protocol.
 * Any request body that contains one of these fields is blocked immediately.
 */
const BANNED_FIELDS = ['replyTo', 'quoteTo', 'reactTo', 'parentId'] as const;

/**
 * Zero-Reply Protocol guard middleware.
 *
 * Intercepts ALL write requests (POST / PUT / PATCH) and rejects any that
 * contain reply / quote / react / thread fields.  A SecurityAuditLog entry
 * is written for every blocked attempt.
 */
export async function zeroReplyGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Only inspect bodies on write methods
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
    next();
    return;
  }

  const body = req.body as Record<string, unknown> | undefined;

  if (!body || typeof body !== 'object') {
    next();
    return;
  }

  const detectedField = BANNED_FIELDS.find((field) => field in body);

  if (!detectedField) {
    next();
    return;
  }

  logger.warn(
    { field: detectedField, ip: req.ip, path: req.path },
    'Zero-reply protocol violation blocked',
  );

  // Persist audit log asynchronously — do not block the 403 response
  prisma.securityAuditLog
    .create({
      data: {
        attemptType: `ZERO_REPLY_FIELD:${detectedField}`,
        ipAddress:   req.ip ?? 'unknown',
        userAgent:   req.headers['user-agent'] ?? 'unknown',
        blocked:     true,
      },
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Failed to persist SecurityAuditLog entry');
    });

  res.status(403).json({ error: 'ZERO_REPLY_PROTOCOL_ACTIVE' });
}
