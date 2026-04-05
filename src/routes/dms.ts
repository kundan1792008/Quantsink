import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { DigitalTwinNetworking } from '../services/DigitalTwinNetworking';
import logger from '../lib/logger';

const router = Router();

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const SendDMSchema = z.object({
  receiverId: z.string().uuid('receiverId must be a valid UUID'),
  content:    z.string().min(1).max(5000),
});

const PaginationSchema = z.object({
  page:  z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

// ---------------------------------------------------------------------------
// POST /api/v1/dms  — send a DM (Zero-Spam pipeline)
// ---------------------------------------------------------------------------
router.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = SendDMSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { receiverId, content } = parsed.data;
    const sender = await prisma.user.findUnique({ where: { quantmailId: req.user!.sub } });
    if (!sender) { res.status(404).json({ error: 'Sender profile not found' }); return; }

    const receiver = await prisma.user.findUnique({ where: { id: receiverId } });
    if (!receiver) { res.status(404).json({ error: 'Receiver not found' }); return; }

    // -----------------------------------------------------------------------
    // Zero-Spam: run the message through the receiver's Digital Twin if enabled
    // -----------------------------------------------------------------------
    let spamScore     = 0;
    let spamAction: 'DELIVERED' | 'SHADOW_INBOX' | 'NEGOTIATED' | 'DROPPED' = 'DELIVERED';
    let handledByTwin = false;

    if (receiver.digitalTwinEnabled) {
      const twin = new DigitalTwinNetworking({
        userId:               receiver.id,
        enabled:              true,
        replyTone:            'professional',
        autonomousCategories: ['GENERAL_NETWORKING', 'COLLABORATION'],
      });

      const action = await twin.handleInquiry({
        senderId:       sender.id,
        senderName:     sender.displayName,
        senderHeadline: sender.headline ?? undefined,
        messageContent: content,
        timestamp:      new Date(),
      });

      spamScore = action.spamScore;
      handledByTwin = action.action !== 'DEFER';

      if (action.action === 'DROP') {
        // Silently drop: acknowledge to sender but never deliver
        logger.info({ senderId: sender.id, receiverId }, 'DM dropped by Digital Twin (spam)');
        res.status(202).json({ message: 'Message processed' });
        return;
      }

      if (action.action === 'NEGOTIATE' || spamScore > 0.5) {
        spamAction = 'SHADOW_INBOX';
      }

      if (action.action === 'REPLY' && action.replyContent) {
        // Persist the auto-reply from the twin
        await prisma.directMessage.create({
          data: {
            senderId:      receiver.id,
            receiverId:    sender.id,
            content:       action.replyContent,
            handledByTwin: true,
          },
        });
      }
    }

    const dm = await prisma.directMessage.create({
      data: {
        senderId:      sender.id,
        receiverId,
        content,
        spamScore,
        spamAction,
        handledByTwin,
      },
    });

    res.status(201).json({ dm });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/dms/inbox  — receiver's inbox (excluding shadow / dropped)
// ---------------------------------------------------------------------------
router.get('/inbox', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = PaginationSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const user = await prisma.user.findUnique({ where: { quantmailId: req.user!.sub } });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const { page, limit } = parsed.data;
    const dms = await prisma.directMessage.findMany({
      where:   { receiverId: user.id, spamAction: 'DELIVERED' },
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    limit,
      include: { sender: { select: { id: true, displayName: true, avatarUrl: true } } },
    });

    res.json({ dms, page, limit });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/dms/shadow  — view the shadow inbox (filtered messages)
// ---------------------------------------------------------------------------
router.get('/shadow', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = PaginationSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const user = await prisma.user.findUnique({ where: { quantmailId: req.user!.sub } });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const { page, limit } = parsed.data;
    const dms = await prisma.directMessage.findMany({
      where:   { receiverId: user.id, spamAction: { in: ['SHADOW_INBOX', 'NEGOTIATED'] } },
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    limit,
      include: { sender: { select: { id: true, displayName: true, avatarUrl: true } } },
    });

    res.json({ dms, page, limit });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/dms/:id/read  — mark a DM as read
// ---------------------------------------------------------------------------
router.patch('/:id/read', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({ where: { quantmailId: req.user!.sub } });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const dm = await prisma.directMessage.findFirst({
      where: { id: req.params.id, receiverId: user.id },
    });
    if (!dm) { res.status(404).json({ error: 'Message not found' }); return; }

    await prisma.directMessage.update({ where: { id: dm.id }, data: { isRead: true } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
