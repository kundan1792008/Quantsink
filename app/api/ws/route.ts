import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.QUANTSINK_API_URL ?? 'http://localhost:3001';

/**
 * GET /api/ws/stats
 * Returns the number of clients currently connected to the WebSocket server.
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const upstream = await fetch(`${BACKEND_URL}/api/v1/ws/stats`);
    const data = await upstream.json();
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ error: 'Upstream service unavailable' }, { status: 503 });
  }
}
