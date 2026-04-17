import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.QUANTSINK_API_URL ?? 'http://localhost:3001';

/**
 * GET /api/influence/leaderboard
 * Proxies to the Express backend at GET /api/v1/influence/leaderboard.
 * Supports `?page=`, `?pageSize=`, and `?nearby=true` query parameters.
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
  const upstreamUrl = new URL(`${BACKEND_URL}/api/v1/influence/leaderboard`);
  searchParams.forEach((value, key) => upstreamUrl.searchParams.set(key, value));

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
