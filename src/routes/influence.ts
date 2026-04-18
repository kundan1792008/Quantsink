import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';

import {
  DEFAULT_CHALLENGE_TEMPLATES,
  InfluenceScoreService,
} from '../services/InfluenceScoreService';
import {
  InMemoryInfluenceStore,
  INFLUENCE_COMPONENT_WEIGHTS,
  INFLUENCE_TIER_THRESHOLDS,
  InfluenceChallengeKind,
  InfluenceScoreSnapshot,
  InfluenceStore,
  tierDescriptor,
} from '../services/InfluenceScoreDomain';
import QualityRatingAI from '../services/QualityRatingAI';
import { requireAuth } from '../middleware/auth';

/**
 * HTTP surface for the Influence Score system.
 *
 *   GET  /api/influence/score        — current user's breakdown
 *   GET  /api/influence/leaderboard  — paginated leaderboard
 *   GET  /api/influence/history      — user's daily snapshots
 *   POST /api/influence/challenge    — start/claim a boost challenge
 *   GET  /api/influence/tiers        — static tier definitions (no auth)
 *   GET  /api/influence/nearby       — users within ±50 of your score
 *
 * All routes are isomorphically-safe: if no `store` is provided by
 * `createInfluenceRouter`, an in-memory default is used, so the
 * application still boots in environments without a database.
 */

const CHALLENGE_KINDS: readonly InfluenceChallengeKind[] = [
  'POST_STREAK',
  'BIOMETRIC_WEEK',
  'CROSS_APP_EXPLORER',
  'QUALITY_AUTHOR',
  'COMMUNITY_UPLIFT',
];

const ChallengeSchema = z.object({
  kind: z.enum(CHALLENGE_KINDS as unknown as [string, ...string[]]),
});

const LeaderboardQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 0 : Number.parseInt(v, 10)))
    .refine((v) => Number.isFinite(v) && v >= 0, {
      message: 'page must be a non-negative integer',
    }),
  pageSize: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 20 : Number.parseInt(v, 10)))
    .refine((v) => Number.isFinite(v) && v >= 1 && v <= 100, {
      message: 'pageSize must be between 1 and 100',
    }),
  tier: z.enum(['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND']).optional(),
});

const HistoryQuerySchema = z.object({
  days: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 30 : Number.parseInt(v, 10)))
    .refine((v) => Number.isFinite(v) && v >= 1 && v <= 90, {
      message: 'days must be between 1 and 90',
    }),
});

const NearbyQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 20 : Number.parseInt(v, 10)))
    .refine((v) => Number.isFinite(v) && v >= 1 && v <= 100, {
      message: 'limit must be between 1 and 100',
    }),
});

export interface CreateInfluenceRouterOptions {
  readonly service?: InfluenceScoreService;
  readonly store?: InfluenceStore;
  readonly quality?: QualityRatingAI;
}

/**
 * Factory — allows the main `app.ts` to inject a custom service
 * (wired to Prisma in production) while keeping defaults that make
 * the route testable in isolation.
 */
export function createInfluenceRouter(
  options: CreateInfluenceRouterOptions = {},
): Router {
  const store = options.store ?? new InMemoryInfluenceStore();
  const quality = options.quality ?? new QualityRatingAI({ store });
  const service =
    options.service ?? new InfluenceScoreService({ store, quality });

  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/influence/tiers — public
  // -------------------------------------------------------------------------
  router.get('/tiers', (_req: Request, res: Response) => {
    res.json({
      weights: INFLUENCE_COMPONENT_WEIGHTS,
      tiers: INFLUENCE_TIER_THRESHOLDS.map((t) => ({
        tier: t.tier,
        label: t.label,
        min: t.min,
        max: t.max,
        accentColor: t.accentColor,
      })),
      challengeTemplates: CHALLENGE_KINDS.map((k) => {
        const template = DEFAULT_CHALLENGE_TEMPLATES[k];
        return {
          kind: template.kind,
          target: template.target,
          rewardPoints: template.rewardPoints,
          durationHours: template.durationHours,
          description: template.description,
        };
      }),
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/influence/score — current user's breakdown
  // -------------------------------------------------------------------------
  router.get(
    '/score',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.sub;
        const breakdown = await service.getBreakdown(userId);
        const rank = await service.rankFor(userId);
        res.json({
          score: {
            userId: breakdown.userId,
            total: breakdown.total,
            tier: breakdown.tier,
            tierLabel: breakdown.tierLabel,
            tierMin: breakdown.tierMin,
            tierMax: breakdown.tierMax,
            tierAccentColor: breakdown.tierAccentColor,
            components: breakdown.components,
            weights: breakdown.weights,
            activeBoostPoints: breakdown.activeBoostPoints,
            activeBoosts: breakdown.activeBoosts,
            lastRecalculatedAt: breakdown.lastRecalculatedAt,
          },
          rank,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/influence/score/recalc — force recompute (current user)
  // -------------------------------------------------------------------------
  router.post(
    '/score/recalc',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.sub;
        const score = await service.recalculate(userId);
        res.json({ score });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/influence/leaderboard
  // -------------------------------------------------------------------------
  router.get(
    '/leaderboard',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = LeaderboardQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
          return;
        }
        const { page, pageSize, tier } = parsed.data;
        const pageResult = await service.getLeaderboard(page, pageSize);
        const filtered = tier
          ? pageResult.rows.filter((row) => row.tier === tier)
          : pageResult.rows;
        res.json({
          leaderboard: filtered,
          total: pageResult.total,
          nextCursor: pageResult.nextCursor,
          page,
          pageSize,
          tier: tier ?? null,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/influence/nearby
  // -------------------------------------------------------------------------
  router.get(
    '/nearby',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = NearbyQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
          return;
        }
        const userId = req.user!.sub;
        const rows = await service.getNearby(userId, parsed.data.limit);
        res.json({ nearby: rows });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/influence/history
  // -------------------------------------------------------------------------
  router.get(
    '/history',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = HistoryQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
          return;
        }
        const userId = req.user!.sub;
        const history = await service.getHistory(userId, parsed.data.days);
        res.json({
          history: history.map(serialiseSnapshot),
          days: parsed.data.days,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/influence/challenge
  // -------------------------------------------------------------------------
  router.post(
    '/challenge',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = ChallengeSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
          return;
        }
        const userId = req.user!.sub;
        const kind = parsed.data.kind as InfluenceChallengeKind;
        const challenge = await service.startChallenge(userId, kind);
        res.status(201).json({ challenge });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/influence/challenges — list current user's challenges
  // -------------------------------------------------------------------------
  router.get(
    '/challenges',
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.sub;
        const challenges = await service.listChallenges(userId);
        res.json({ challenges });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

function serialiseSnapshot(snap: InfluenceScoreSnapshot): Record<string, unknown> {
  const descriptor = tierDescriptor(snap.tier);
  return {
    snapshotAt: snap.snapshotAt.toISOString(),
    total: snap.total,
    components: snap.components,
    tier: snap.tier,
    tierLabel: descriptor.label,
    tierAccentColor: descriptor.accentColor,
  };
}

// Default export — used by `app.ts` with the shared store/service.
const defaultRouter = createInfluenceRouter();
export default defaultRouter;
