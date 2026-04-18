import logger from '../lib/logger';

/**
 * QuantmailLivenessService
 *
 * Performs a real-time biometric liveness pre-flight check against the
 * Quantmail identity platform before a broadcast is published.
 *
 * In production this calls the Quantmail Liveness Grid API. The endpoint
 * and timeout are configured via environment variables:
 *   QUANTMAIL_API_URL  — base URL (e.g. https://api.quantmail.io)
 *   QUANTMAIL_LIVENESS_TIMEOUT_MS — per-request timeout (default 3000 ms)
 *
 * If QUANTMAIL_LIVENESS_SKIP is set to "true" (e.g. in CI / local dev) the
 * check is bypassed and the function returns `true` immediately so that
 * developers can test without a live Quantmail instance.
 */

export class QuantmailLivenessService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string  = process.env.QUANTMAIL_API_URL  ?? '',
    timeoutMs: number = parseInt(process.env.QUANTMAIL_LIVENESS_TIMEOUT_MS ?? '3000', 10),
  ) {
    this.baseUrl   = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Returns `true` when the user's liveness grid is currently active.
   * Returns `false` if the grid is dormant or the API cannot be reached.
   *
   * @param userId  The Quantmail subject ID from the bearer token payload.
   */
  async checkLiveness(userId: string): Promise<boolean> {
    if (process.env.QUANTMAIL_LIVENESS_SKIP === 'true') {
      logger.debug({ userId }, 'QuantmailLiveness: skipping (QUANTMAIL_LIVENESS_SKIP=true)');
      return true;
    }

    if (!this.baseUrl) {
      logger.warn({ userId }, 'QuantmailLiveness: QUANTMAIL_API_URL not configured, denying broadcast');
      return false;
    }

    const url = `${this.baseUrl}/v1/liveness/${encodeURIComponent(userId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method:  'GET',
        headers: { 'X-Service': 'quantsink' },
        signal:  controller.signal,
      });

      if (res.ok) {
        const body = await res.json() as { active?: boolean };
        const active = body.active === true;
        logger.info({ userId, active }, 'QuantmailLiveness: grid status received');
        return active;
      }

      logger.warn({ userId, status: res.status }, 'QuantmailLiveness: non-OK response, denying broadcast');
      return false;
    } catch (err) {
      logger.error({ userId, err }, 'QuantmailLiveness: request failed, denying broadcast');
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Singleton used by the route layer; can be replaced in tests via dependency
// injection or by setting QUANTMAIL_LIVENESS_SKIP=true.
export const quantmailLiveness = new QuantmailLivenessService();
