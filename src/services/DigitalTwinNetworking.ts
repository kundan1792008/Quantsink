import logger from '../lib/logger';

export type InquiryCategory =
  | 'JOB_OFFER'
  | 'PARTNERSHIP'
  | 'SALES_PITCH'
  | 'COLLABORATION'
  | 'GENERAL_NETWORKING'
  | 'UNKNOWN';

export interface DigitalTwinConfig {
  /** User's Quantsink user ID */
  userId: string;
  /** Whether the digital twin is active for this user */
  enabled: boolean;
  /** Tone the twin should adopt when replying */
  replyTone: 'professional' | 'friendly' | 'brief';
  /** Categories the owner wants the twin to handle autonomously */
  autonomousCategories: InquiryCategory[];
  /** Custom system prompt / persona instructions */
  persona?: string;
}

export interface IncomingInquiry {
  senderId: string;
  senderName: string;
  senderHeadline?: string;
  messageContent: string;
  timestamp: Date;
}

export interface TwinAction {
  action: 'REPLY' | 'NEGOTIATE' | 'DEFER' | 'DROP';
  replyContent?: string;
  reason: string;
  category: InquiryCategory;
  spamScore: number;      // 0 – 1; sourced from Quantmail shadow-inbox filter
}

/**
 * DigitalTwinNetworking
 *
 * Service stub for the user's AI agent that automatically replies to
 * professional inquiries, networks, and negotiates 24/7 on the user's behalf.
 *
 * In production this would be backed by an LLM inference endpoint
 * (e.g. OpenAI / local Quantmail-hosted model) and have access to the user's
 * professional history, calendar, and preferences stored in Prisma.
 *
 * The Quantmail shadow-inbox filter API is consulted first to score each
 * incoming message for spam/unsolicited-pitch likelihood before any action
 * is taken.
 */
export class DigitalTwinNetworking {
  private readonly config: DigitalTwinConfig;

  constructor(config: DigitalTwinConfig) {
    this.config = config;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Primary entry point.  Given an incoming DM/inquiry, the twin decides
   * what to do and returns a TwinAction.
   */
  async handleInquiry(inquiry: IncomingInquiry): Promise<TwinAction> {
    if (!this.config.enabled) {
      return {
        action: 'DEFER',
        reason: 'Digital twin is disabled for this user',
        category: 'UNKNOWN',
        spamScore: 0,
      };
    }

    const spamScore = await this.getSpamScore(inquiry);
    const category  = await this.classifyInquiry(inquiry);

    logger.info(
      { userId: this.config.userId, senderId: inquiry.senderId, category, spamScore },
      'DigitalTwin: classifying inquiry',
    );

    // Hard drop for high-confidence spam
    if (spamScore > 0.85) {
      return { action: 'DROP', reason: 'High spam score', category, spamScore };
    }

    // Shadow-inbox / negotiate for mid-range unsolicited pitches
    if (spamScore > 0.5 && category === 'SALES_PITCH') {
      const replyContent = await this.generateNegotiationReply(inquiry, category);
      return { action: 'NEGOTIATE', replyContent, reason: 'Unsolicited sales pitch — negotiating', category, spamScore };
    }

    // Autonomous reply for allowed categories
    if (this.config.autonomousCategories.includes(category)) {
      const replyContent = await this.generateAutoReply(inquiry, category);
      return { action: 'REPLY', replyContent, reason: 'Handled autonomously by digital twin', category, spamScore };
    }

    // Everything else — surface to the real user
    return {
      action: 'DEFER',
      reason: 'Category not in autonomous list — deferring to user',
      category,
      spamScore,
    };
  }

  /**
   * Proactively reach out to a target on the user's behalf (networking mode).
   * Returns the drafted outreach message for the user to review before sending
   * (or sends automatically if the user has enabled fully-autonomous mode).
   */
  async draftOutreach(targetUserId: string, context: string): Promise<string> {
    logger.info(
      { userId: this.config.userId, targetUserId },
      'DigitalTwin: drafting outreach',
    );

    // TODO: integrate with LLM inference endpoint and user's professional history
    return (
      `Hi! I'm reaching out on behalf of ${this.config.userId}. ` +
      `Context: ${context}. Looking forward to connecting!`
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers (stubs — to be wired to real services)
  // ---------------------------------------------------------------------------

  /**
   * Consults the Quantmail shadow-inbox filter API for a spam score.
   * Returns a float in [0, 1] where 1 = definite spam.
   * Falls back to a local keyword heuristic when the API is not configured.
   */
  private async getSpamScore(inquiry: IncomingInquiry): Promise<number> {
    const quantmailFilterUrl = process.env.QUANTMAIL_FILTER_API_URL;

    if (quantmailFilterUrl) {
      try {
        // TODO: replace stub with actual Quantmail filter API call
        // const response = await fetch(`${quantmailFilterUrl}/score`, {
        //   method: 'POST',
        //   headers: { 'Content-Type': 'application/json' },
        //   body: JSON.stringify({ content: inquiry.messageContent, senderId: inquiry.senderId }),
        // });
        // const data = await response.json();
        // return data.spamScore as number;
      } catch (err) {
        logger.error({ err }, 'DigitalTwin: Quantmail filter API call failed — falling back to heuristic');
      }
    }

    // Local keyword heuristic (used when API is unavailable or not configured)
    const text = inquiry.messageContent.toLowerCase();
    const spamKeywords = ['guaranteed roi', 'investment opportunity', 'click here', 'limited time', 'buy now'];
    const hits = spamKeywords.filter(kw => text.includes(kw)).length;
    return Math.min(hits * 0.2, 1);
  }

  /**
   * Classifies the purpose of an incoming message.
   * TODO: replace stub with an LLM classifier call.
   */
  private async classifyInquiry(inquiry: IncomingInquiry): Promise<InquiryCategory> {
    const text = inquiry.messageContent.toLowerCase();

    if (text.includes('job') || text.includes('hire') || text.includes('opportunity'))  return 'JOB_OFFER';
    if (text.includes('partner') || text.includes('collaborate'))                        return 'COLLABORATION';
    if (text.includes('buy') || text.includes('service') || text.includes('offer'))      return 'SALES_PITCH';
    if (text.includes('connect') || text.includes('network'))                            return 'GENERAL_NETWORKING';

    return 'UNKNOWN';
  }

  private async generateAutoReply(inquiry: IncomingInquiry, category: InquiryCategory): Promise<string> {
    // TODO: wire to LLM with user persona & professional history
    const tone = this.config.replyTone;
    const persona = this.config.persona ?? 'a professional';
    return (
      `Thanks for reaching out, ${inquiry.senderName}! ` +
      `As ${persona}, I'm interested in ${category.toLowerCase().replace('_', ' ')}. ` +
      `Let's schedule a time to connect. — (Replied by your Quantsink Digital Twin, tone: ${tone})`
    );
  }

  private async generateNegotiationReply(inquiry: IncomingInquiry, category: InquiryCategory): Promise<string> {
    return (
      `Hi ${inquiry.senderName}, thank you for your message. ` +
      `I currently filter unsolicited ${category.toLowerCase().replace('_', ' ')} inquiries through my AI assistant. ` +
      `If you believe this is a genuine opportunity, please provide more details and I will review it personally.`
    );
  }
}
