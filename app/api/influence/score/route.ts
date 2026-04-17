import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.QUANTSINK_API_URL ?? 'http://localhost:3001';

/**
 * GET /api/influence/score
 * Proxies to the Express backend at GET /api/v1/influence/score.
 * Returns the current user's influence score breakdown with tier and rank.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Missing or malformed Authorization header' },
      { status: 401 },
    );
  }

  try {
    const upstream = await fetch(`${BACKEND_URL}/api/v1/influence/score`, {
      headers: { Authorization: authHeader },
    });
    const data = await upstream.json();
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ error: 'Upstream service unavailable' }, { status: 503 });
  }
}
