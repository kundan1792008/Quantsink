import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';

const router = Router();

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const CreateShortPostSchema = z.object({
  content: z
    .string()
    .min(1, 'Content cannot be empty')
    .max(500, 'Short posts are limited to 500 characters'),
  mediaUrls: z.array(z.string().url()).optional().default([]),
  hashtags: z.array(z.string()).optional().default([]),
});

const CreateDeepPostSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().max(300).optional(),
  content: z.string().min(1, 'Content cannot be empty'),
  coverImageUrl: z.string().url().optional(),
  tags: z.array(z.string()).optional().default([]),
  readTimeMin: z.number().int().positive().optional(),
  isPublished: z.boolean().optional().default(false),
});

const FeedQuerySchema = z.object({
  page:  z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

// ---------------------------------------------------------------------------
// POST /api/v1/posts/short
// ---------------------------------------------------------------------------
router.post('/short', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = CreateShortPostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { content, mediaUrls, hashtags } = parsed.data;
    const userId = req.user!.sub;

    // Upsert the user record (first call after Quantmail SSO)
    await prisma.user.upsert({
      where:  { quantmailId: userId },
      update: {},
      create: {
        quantmailId: userId,
        email:       req.user!.email,
        displayName: req.user!.displayName ?? req.user!.email,
      },
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { quantmailId: userId } });

    const post = await prisma.shortPost.create({
      data: { authorId: user.id, content, mediaUrls, hashtags },
    });

    res.status(201).json({ post });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/posts/deep
// ---------------------------------------------------------------------------
router.post('/deep', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = CreateDeepPostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { title, summary, content, coverImageUrl, tags, readTimeMin, isPublished } = parsed.data;
    const userId = req.user!.sub;

    await prisma.user.upsert({
      where:  { quantmailId: userId },
      update: {},
      create: {
        quantmailId: userId,
        email:       req.user!.email,
        displayName: req.user!.displayName ?? req.user!.email,
      },
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { quantmailId: userId } });

    const post = await prisma.deepPost.create({
      data: {
        authorId:      user.id,
        title,
        summary,
        content,
        coverImageUrl,
        tags,
        readTimeMin,
        isPublished,
        publishedAt:   isPublished ? new Date() : null,
      },
    });

    res.status(201).json({ post });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/posts/feed  — merged dual feed (short + deep, time-ordered)
// ---------------------------------------------------------------------------
router.get('/feed', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = FeedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { page, limit } = parsed.data;
    const skip = (page - 1) * limit;

    // Fetch both post types in parallel
    const [shortPosts, deepPosts] = await Promise.all([
      prisma.shortPost.findMany({
        where:   { isDeleted: false },
        orderBy: { createdAt: 'desc' },
        skip,
        take:    limit,
        include: { author: { select: { id: true, displayName: true, avatarUrl: true, headline: true } } },
      }),
      prisma.deepPost.findMany({
        where:   { isDeleted: false, isPublished: true },
        orderBy: { publishedAt: 'desc' },
        skip,
        take:    limit,
        include: { author: { select: { id: true, displayName: true, avatarUrl: true, headline: true } } },
      }),
    ]);

    // Merge and sort by date descending
    const feed = [
      ...shortPosts.map(p => ({ type: 'short' as const, ...p })),
      ...deepPosts.map(p => ({ type: 'deep' as const, ...p })),
    ].sort((a, b) => {
      const dateA = a.type === 'deep' && a.publishedAt ? a.publishedAt : a.createdAt;
      const dateB = b.type === 'deep' && b.publishedAt ? b.publishedAt : b.createdAt;
      return dateB.getTime() - dateA.getTime();
    });

    res.json({ feed: feed.slice(0, limit), page, limit });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/posts/short/:id
// ---------------------------------------------------------------------------
router.get('/short/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const post = await prisma.shortPost.findFirst({
      where:   { id: req.params.id, isDeleted: false },
      include: { author: { select: { id: true, displayName: true, avatarUrl: true } } },
    });

    if (!post) { res.status(404).json({ error: 'Post not found' }); return; }
    res.json({ post });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/posts/deep/:id
// ---------------------------------------------------------------------------
router.get('/deep/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const post = await prisma.deepPost.findFirst({
      where:   { id: req.params.id, isDeleted: false },
      include: { author: { select: { id: true, displayName: true, avatarUrl: true } } },
    });

    if (!post) { res.status(404).json({ error: 'Post not found' }); return; }
    res.json({ post });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/posts/short/:id  (soft delete)
// ---------------------------------------------------------------------------
router.delete('/short/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const user   = await prisma.user.findUnique({ where: { quantmailId: userId } });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const post = await prisma.shortPost.findFirst({ where: { id: req.params.id, authorId: user.id } });
    if (!post) { res.status(404).json({ error: 'Post not found or not owned by you' }); return; }

    await prisma.shortPost.update({ where: { id: post.id }, data: { isDeleted: true } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/posts/deep/:id  (soft delete)
// ---------------------------------------------------------------------------
router.delete('/deep/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const user   = await prisma.user.findUnique({ where: { quantmailId: userId } });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    const post = await prisma.deepPost.findFirst({ where: { id: req.params.id, authorId: user.id } });
    if (!post) { res.status(404).json({ error: 'Post not found or not owned by you' }); return; }

    await prisma.deepPost.update({ where: { id: post.id }, data: { isDeleted: true } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
