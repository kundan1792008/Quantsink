import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { InfluenceScoreService } from '../services/InfluenceScoreService';
import { ScoreDecayWorker } from '../workers/ScoreDecayWorker';
import prisma from '../lib/prisma';

const router = Router();
const influenceService = new InfluenceScoreService();
const decayWorker = new ScoreDecayWorker();

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const PaginationSchema = z.object({
  page:     z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(50),
  nearby:   z.coerce.boolean().optional().default(false),
});

const HistorySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional().default(30),
});

const ChallengeSchema = z.object({
  challengeType: z
    .enum(['DAILY_POST', 'ENGAGEMENT_SPIKE', 'CROSS_APP_VISIT', 'BIOMETRIC_REFRESH', 'COMMUNITY_VOUCH'])
    .optional(),
});

const CompleteBoostSchema = z.object({
  challengeId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Helper — resolve the DB user from the JWT sub
// ---------------------------------------------------------------------------
async function resolveUser(
  req: Request,
  res: Response,
): Promise<{ id: string } | null> {
  const userId = req.user!.sub;
  const user = await prisma.user.findUnique({
    where:  { quantmailId: userId },
    select: { id: true },
  });
  if (!user) {
    res.status(404).json({ error: 'User profile not found. Please post something first.' });
    return null;
  }
  return user;
}

// ---------------------------------------------------------------------------
// GET /api/v1/influence/score — current user's score breakdown
// ---------------------------------------------------------------------------
router.get('/score', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await resolveUser(req, res);
    if (!user) return;

    const result = await influenceService.getScore(user.id);
    const effectiveScore = await decayWorker.effectiveScore(user.id);

    res.json({
      userId:           result.userId,
      totalScore:       result.totalScore,
      effectiveScore,   // includes active challenge boosts
      tier:             result.tier,
      rankPosition:     result.rankPosition,
      lastCalculatedAt: result.lastCalculatedAt,
      components: {
        broadcastQuality:  { score: result.components.broadcastQuality,  weight: '25%' },
        engagementRate:    { score: result.components.engagementRate,    weight: '20%' },
        consistency:       { score: result.components.consistency,       weight: '15%' },
        biometricLevel:    { score: result.components.biometricLevel,    weight: '15%' },
        crossAppActivity:  { score: result.components.crossAppActivity,  weight: '15%' },
        communityStanding: { score: result.components.communityStanding, weight: '10%' },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/influence/leaderboard — paginated leaderboard
// ---------------------------------------------------------------------------
router.get('/leaderboard', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = PaginationSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { page, pageSize, nearby } = parsed.data;
    const user = await resolveUser(req, res);
    if (!user) return;

    if (nearby) {
      const entries = await influenceService.getNearbyLeaderboard(user.id);
      res.json({ entries, type: 'nearby' });
      return;
    }

    const board = await influenceService.getLeaderboard(page, pageSize);
    res.json(board);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/influence/history — score history with daily snapshots
// ---------------------------------------------------------------------------
router.get('/history', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = HistorySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const user = await resolveUser(req, res);
    if (!user) return;

    const history = await influenceService.getHistory(user.id, parsed.data.days);
    res.json({ history, days: parsed.data.days });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/influence/challenge — start a challenge for boost points
// ---------------------------------------------------------------------------
router.post('/challenge', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = ChallengeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const user = await resolveUser(req, res);
    if (!user) return;

    const result = await influenceService.startChallenge(user.id, parsed.data.challengeType);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/influence/challenge/complete — mark a challenge complete
// ---------------------------------------------------------------------------
router.post('/challenge/complete', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = CompleteBoostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const user = await resolveUser(req, res);
    if (!user) return;

    const newScore = await decayWorker.applyBoostEvent(user.id, parsed.data.challengeId);
    if (newScore === null) {
      res.status(404).json({ error: 'Challenge not found, expired, or already completed.' });
      return;
    }

    res.json({ effectiveScore: newScore, message: 'Challenge completed! +50 boost applied for 24 hours.' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/influence/recalculate — trigger manual recalculation
// ---------------------------------------------------------------------------
router.post('/recalculate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await resolveUser(req, res);
    if (!user) return;

    const result = await influenceService.recalculate(user.id, true);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
