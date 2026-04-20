import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { Prisma } from '@prisma/client';

const router = Router();

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ConnectSchema = z.object({
  targetUserId: z.string().uuid(),
  message: z.string().max(300).optional(),
});

const RespondConnectionSchema = z.object({
  action: z.enum(['ACCEPT', 'DECLINE']),
});

const EndorseSchema = z.object({
  endorsedUserId: z.string().uuid(),
  skillName: z.string().min(1).max(100),
});

const AddSkillSchema = z.object({
  skillName: z.string().min(1).max(100),
  category: z.string().max(100).optional(),
});

// ---------------------------------------------------------------------------
// POST /api/v1/connections/connect  — send a connection request
// ---------------------------------------------------------------------------
router.post('/connect', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = ConnectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { targetUserId, message } = parsed.data;

    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized: user not authenticated' });
      return;
    }

    const fromUser = await prisma.user.findUnique({ where: { quantmailId: req.user.sub } });
    if (!fromUser) { res.status(404).json({ error: 'Your user profile not found' }); return; }

    if (fromUser.id === targetUserId) {
      res.status(400).json({ error: 'Cannot connect with yourself' });
      return;
    }

    const existing = await prisma.connection.findUnique({
      where: { fromUserId_toUserId: { fromUserId: fromUser.id, toUserId: targetUserId } },
    });
    if (existing) {
      res.status(409).json({ error: 'Connection request already exists', status: existing.status });
      return;
    }

    const connection = await prisma.connection.create({
      data: { fromUserId: fromUser.id, toUserId: targetUserId, message },
    });

    res.status(201).json({ connection });
  } catch (err) {
    // Handle Prisma unique constraint violations
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') {
        res.status(409).json({ error: 'Connection request already exists' });
        return;
      }
      if (err.code === 'P2025') {
        res.status(404).json({ error: 'Target user not found' });
        return;
      }
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/connections/:id  — accept or decline a connection request
// ---------------------------------------------------------------------------
router.patch('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = RespondConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized: user not authenticated' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { quantmailId: req.user.sub } });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const conn = await prisma.connection.findFirst({
      where: { id: req.params.id, toUserId: user.id, status: 'PENDING' },
    });
    if (!conn) { res.status(404).json({ error: 'Connection request not found' }); return; }

    const updated = await prisma.connection.update({
      where: { id: conn.id },
      data:  { status: parsed.data.action === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED' },
    });

    res.json({ connection: updated });
  } catch (err) {
    // Handle Prisma errors
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2025') {
        res.status(404).json({ error: 'Connection not found or already processed' });
        return;
      }
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/connections  — list current user's connections
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({ where: { quantmailId: req.user!.sub } });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const connections = await prisma.connection.findMany({
      where: {
        OR: [{ fromUserId: user.id }, { toUserId: user.id }],
        status: 'ACCEPTED',
      },
      include: {
        fromUser: { select: { id: true, displayName: true, headline: true, avatarUrl: true } },
        toUser:   { select: { id: true, displayName: true, headline: true, avatarUrl: true } },
      },
    });

    res.json({ connections });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/connections/follow  — follow a user (unidirectional)
// ---------------------------------------------------------------------------
router.post('/follow', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({ targetUserId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized: user not authenticated' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { quantmailId: req.user.sub } });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    if (user.id === parsed.data.targetUserId) {
      res.status(400).json({ error: 'Cannot follow yourself' });
      return;
    }

    const follow = await prisma.follow.upsert({
      where:  { sourceId_targetId: { sourceId: user.id, targetId: parsed.data.targetUserId } },
      update: {},
      create: { sourceId: user.id, targetId: parsed.data.targetUserId },
    });

    res.status(201).json({ follow });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/connections/follow/:targetId  — unfollow
// ---------------------------------------------------------------------------
router.delete('/follow/:targetId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({ where: { quantmailId: req.user!.sub } });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    await prisma.follow.deleteMany({
      where: { sourceId: user.id, targetId: req.params.targetId },
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/connections/skills  — add a skill to your profile
// ---------------------------------------------------------------------------
router.post('/skills', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = AddSkillSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized: user not authenticated' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { quantmailId: req.user.sub } });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const skill = await prisma.skill.upsert({
      where:  { name: parsed.data.skillName },
      update: {},
      create: { name: parsed.data.skillName, category: parsed.data.category },
    });

    const userSkill = await prisma.userSkill.upsert({
      where:  { userId_skillId: { userId: user.id, skillId: skill.id } },
      update: {},
      create: { userId: user.id, skillId: skill.id },
    });

    res.status(201).json({ userSkill, skill });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/connections/endorse  — endorse a skill on someone else's profile
// ---------------------------------------------------------------------------
router.post('/endorse', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = EndorseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { endorsedUserId, skillName } = parsed.data;

    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized: user not authenticated' });
      return;
    }

    const endorser = await prisma.user.findUnique({ where: { quantmailId: req.user.sub } });
    if (!endorser) { res.status(404).json({ error: 'Your user profile not found' }); return; }

    if (endorser.id === endorsedUserId) {
      res.status(400).json({ error: 'Cannot endorse your own skills' });
      return;
    }

    const skill = await prisma.skill.findUnique({ where: { name: skillName } });
    if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }

    const userSkill = await prisma.userSkill.findUnique({
      where: { userId_skillId: { userId: endorsedUserId, skillId: skill.id } },
    });
    if (!userSkill) {
      res.status(404).json({ error: 'Target user does not have this skill' });
      return;
    }

    const endorsement = await prisma.endorsement.upsert({
      where: { endorserId_userSkillId: { endorserId: endorser.id, userSkillId: userSkill.id } },
      update: {},
      create: { endorserId: endorser.id, endorsedId: endorsedUserId, userSkillId: userSkill.id },
    });

    res.status(201).json({ endorsement });
  } catch (err) {
    next(err);
  }
});

export default router;
