import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { pushBroadcast } from '../services/BroadcastWebSocket';

const router = Router();

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------
const CreateBroadcastSchema = z.object({
  content: z
    .string()
    .min(1, 'Content cannot be empty')
    .max(2000, 'Broadcast content is limited to 2000 characters'),
  biometricHash: z
    .string()
    .min(1, 'Biometric hash is required'),
});

const CursorQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// POST /api/v1/broadcasts — create a new broadcast
// ---------------------------------------------------------------------------
router.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = CreateBroadcastSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { content, biometricHash } = parsed.data;
    const userId = req.user!.sub;

    // Upsert author so the first broadcast from a new user auto-creates their profile
    await prisma.user.upsert({
      where:  { quantmailId: userId },
      update: {},
      create: {
        quantmailId: userId,
        email:       req.user!.email,
        displayName: req.user!.displayName ?? req.user!.email,
      },
    });

    const author = await prisma.user.findUniqueOrThrow({ where: { quantmailId: userId } });

    const broadcast = await prisma.broadcast.create({
      data: {
        authorId:         author.id,
        content,
        biometricHash,
        biometricVerified: true,
      },
      include: {
        author: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });

    // Push to all connected WebSocket clients (non-blocking)
    pushBroadcast({
      id:                   broadcast.id,
      content:              broadcast.content,
      authorId:             broadcast.authorId,
      authorDisplayName:    broadcast.author.displayName,
      biometricVerified:    broadcast.biometricVerified,
      createdAt:            broadcast.createdAt.toISOString(),
    });

    res.status(201).json({ broadcast });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/broadcasts — paginated broadcast feed (cursor-based, 20/page)
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = CursorQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid cursor', details: parsed.error.flatten() });
      return;
    }

    const { cursor } = parsed.data;
    const PAGE_SIZE  = 20;

    const broadcasts = await prisma.broadcast.findMany({
      where:   { deletedAt: null },
      take:    PAGE_SIZE + 1,
      ...(cursor
        ? { skip: 1, cursor: { id: cursor } }
        : {}),
      orderBy: { createdAt: 'desc' },
      include: {
        author: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });

    const hasNextPage = broadcasts.length > PAGE_SIZE;
    const items       = hasNextPage ? broadcasts.slice(0, PAGE_SIZE) : broadcasts;
    const nextCursor  = hasNextPage ? items[items.length - 1].id : null;

    res.json({
      broadcasts:  items.map((b) => ({
        id:                b.id,
        content:           b.content,
        biometricVerified: b.biometricVerified,
        viewCount:         b.viewCount,
        createdAt:         b.createdAt,
        author:            b.author,
      })),
      nextCursor,
      hasNextPage,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/broadcasts/:id — soft-delete (author only)
// ---------------------------------------------------------------------------
router.delete('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;

    const author = await prisma.user.findUnique({ where: { quantmailId: userId } });
    if (!author) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const broadcast = await prisma.broadcast.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });

    if (!broadcast) {
      res.status(404).json({ error: 'Broadcast not found' });
      return;
    }

    if (broadcast.authorId !== author.id) {
      res.status(403).json({ error: 'Forbidden: you are not the author of this broadcast' });
      return;
    }

    await prisma.broadcast.update({
      where: { id: req.params.id },
      data:  { deletedAt: new Date() },
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
