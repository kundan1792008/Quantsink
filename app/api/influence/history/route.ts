import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.QUANTSINK_API_URL ?? 'http://localhost:3001';

/**
 * GET /api/influence/history
 * Proxies to the Express backend at GET /api/v1/influence/history.
 * Supports `?days=N` (1-90) query parameter for the score history window.
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
  const upstreamUrl = new URL(`${BACKEND_URL}/api/v1/influence/history`);
  const days = searchParams.get('days');
  if (days) upstreamUrl.searchParams.set('days', days);

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
