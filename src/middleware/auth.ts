import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import logger from '../lib/logger';

/** Shape of a Quantmail-issued JWT payload */
export interface QuantmailJwtPayload {
  sub: string;          // Quantmail user ID
  email: string;
  displayName?: string;
  biometricVerified: boolean;
  iat: number;
  exp: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: QuantmailJwtPayload;
    }
  }
}

const QUANTMAIL_JWT_SECRET = process.env.QUANTMAIL_JWT_SECRET ?? '';

/**
 * Biometric SSO middleware.
 *
 * Validates the Quantmail-issued JWT carried in the `Authorization: Bearer …`
 * header.  No local passwords are accepted — the Quantmail identity is the
 * single source of truth for authentication across the Quant Ecosystem.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers['authorization'];

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  if (!QUANTMAIL_JWT_SECRET) {
    logger.error('QUANTMAIL_JWT_SECRET is not configured');
    res.status(500).json({ error: 'Server misconfiguration' });
    return;
  }

  try {
    const payload = jwt.verify(token, QUANTMAIL_JWT_SECRET) as QuantmailJwtPayload;

    if (!payload.biometricVerified) {
      res.status(403).json({ error: 'Biometric verification required' });
      return;
    }

    req.user = payload;
    next();
  } catch (err) {
    logger.warn({ err }, 'JWT verification failed');
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
