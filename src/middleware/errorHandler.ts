import { Request, Response, NextFunction } from 'express';
import logger from '../lib/logger';

/** Central error handler — logs and returns a clean JSON body. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // Express requires the fourth argument even if unused
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const message = err instanceof Error ? err.message : 'Internal server error';
  logger.error({ err, path: req.path, method: req.method }, message);
  res.status(500).json({ error: message });
}
