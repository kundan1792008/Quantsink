import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.QUANTSINK_API_URL ?? 'http://localhost:3001';

/**
 * POST /api/broadcasts
 * Proxies to the Express backend at POST /api/v1/broadcasts.
 * Requires `Authorization: Bearer <biometric_jwt>` header.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Missing or malformed Authorization header' },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Enforce Zero-Reply Protocol at the Next.js edge layer too
  const BANNED_FIELDS = ['replyTo', 'quoteTo', 'reactTo', 'parentId'];
  if (body && typeof body === 'object') {
    for (const field of BANNED_FIELDS) {
      if (field in (body as Record<string, unknown>)) {
        return NextResponse.json(
          { error: 'ZERO_REPLY_PROTOCOL_ACTIVE' },
          { status: 403 },
        );
      }
    }
  }

  try {
    const upstream = await fetch(`${BACKEND_URL}/api/v1/broadcasts`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization:   authHeader,
      },
      body: JSON.stringify(body),
    });

    const data = await upstream.json();
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ error: 'Upstream service unavailable' }, { status: 503 });
  }
}

/**
 * GET /api/broadcasts
 * Proxies to GET /api/v1/broadcasts with cursor-based pagination.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Missing or malformed Authorization header' },
      { status: 401 },
    );
  }

  const { searchParams } = request.nextUrl;
  const cursor = searchParams.get('cursor');
  const upstreamUrl = new URL(`${BACKEND_URL}/api/v1/broadcasts`);
  if (cursor) upstreamUrl.searchParams.set('cursor', cursor);

  try {
    const upstream = await fetch(upstreamUrl.toString(), {
      headers: { Authorization: authHeader },
    });
    const data = await upstream.json();
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ error: 'Upstream service unavailable' }, { status: 503 });
  }
}
