import { QuantmailLivenessService } from '../services/QuantmailLivenessService';

describe('QuantmailLivenessService', () => {
  it('returns true when QUANTMAIL_LIVENESS_SKIP=true', async () => {
    const prev = process.env.QUANTMAIL_LIVENESS_SKIP;
    process.env.QUANTMAIL_LIVENESS_SKIP = 'true';

    const svc = new QuantmailLivenessService();
    const result = await svc.checkLiveness('user-1');
    expect(result).toBe(true);

    process.env.QUANTMAIL_LIVENESS_SKIP = prev ?? '';
  });

  it('returns false when QUANTMAIL_API_URL is not configured', async () => {
    const prevSkip = process.env.QUANTMAIL_LIVENESS_SKIP;
    const prevUrl  = process.env.QUANTMAIL_API_URL;

    process.env.QUANTMAIL_LIVENESS_SKIP = '';
    process.env.QUANTMAIL_API_URL       = '';

    const svc = new QuantmailLivenessService('');
    const result = await svc.checkLiveness('user-1');
    expect(result).toBe(false);

    process.env.QUANTMAIL_LIVENESS_SKIP = prevSkip ?? '';
    process.env.QUANTMAIL_API_URL       = prevUrl  ?? '';
  });

  it('returns false when the Quantmail API is unreachable', async () => {
    const prevSkip = process.env.QUANTMAIL_LIVENESS_SKIP;
    process.env.QUANTMAIL_LIVENESS_SKIP = '';

    const svc = new QuantmailLivenessService('http://127.0.0.1:19999', 500);
    const result = await svc.checkLiveness('user-1');
    expect(result).toBe(false);

    process.env.QUANTMAIL_LIVENESS_SKIP = prevSkip ?? '';
  }, 5000);
});
