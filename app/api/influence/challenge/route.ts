import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.QUANTSINK_API_URL ?? 'http://localhost:3001';

/**
 * POST /api/influence/challenge
 * Proxies to the Express backend at POST /api/v1/influence/challenge.
 * Body: { challengeType?: 'DAILY_POST' | 'ENGAGEMENT_SPIKE' | 'CROSS_APP_VISIT' | 'BIOMETRIC_REFRESH' | 'COMMUNITY_VOUCH' }
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
    body = {};
  }

  try {
    const upstream = await fetch(`${BACKEND_URL}/api/v1/influence/challenge`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  authHeader,
      },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ error: 'Upstream service unavailable' }, { status: 503 });
  }
}
