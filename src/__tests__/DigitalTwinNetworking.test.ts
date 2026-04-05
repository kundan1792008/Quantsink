import { DigitalTwinNetworking, IncomingInquiry } from '../services/DigitalTwinNetworking';

describe('DigitalTwinNetworking', () => {
  const baseConfig = {
    userId: 'user-123',
    enabled: true,
    replyTone: 'professional' as const,
    autonomousCategories: ['GENERAL_NETWORKING', 'COLLABORATION'] as Array<'GENERAL_NETWORKING' | 'COLLABORATION'>,
  };

  it('should defer when digital twin is disabled', async () => {
    const twin = new DigitalTwinNetworking({ ...baseConfig, enabled: false });
    const inquiry: IncomingInquiry = {
      senderId: 'sender-1',
      senderName: 'Alice',
      messageContent: 'Hello, I would like to connect.',
      timestamp: new Date(),
    };
    const action = await twin.handleInquiry(inquiry);
    expect(action.action).toBe('DEFER');
    expect(action.reason).toMatch(/disabled/i);
  });

  it('should reply autonomously for general networking inquiries', async () => {
    const twin = new DigitalTwinNetworking(baseConfig);
    const inquiry: IncomingInquiry = {
      senderId: 'sender-2',
      senderName: 'Bob',
      messageContent: 'Hi, I would like to network and connect with you.',
      timestamp: new Date(),
    };
    const action = await twin.handleInquiry(inquiry);
    expect(action.category).toBe('GENERAL_NETWORKING');
    expect(action.action).toBe('REPLY');
    expect(action.replyContent).toBeDefined();
  });

  it('should negotiate for sales pitches with moderate spam score', async () => {
    const twin = new DigitalTwinNetworking(baseConfig);
    const inquiry: IncomingInquiry = {
      senderId: 'sender-3',
      senderName: 'Spammy Corp',
      // "buy now" + "guaranteed roi" => spamScore=0.4, and "buy" triggers SALES_PITCH classification
      // spamScore > 0.5 would be needed for negotiate, so use 3 keywords: buy now + guaranteed roi + click here = 0.6
      messageContent: 'please buy now our guaranteed roi, click here to learn more',
      timestamp: new Date(),
    };
    const action = await twin.handleInquiry(inquiry);
    expect(action.category).toBe('SALES_PITCH');
    expect(['NEGOTIATE', 'DROP']).toContain(action.action);
  });

  it('should drop high-spam messages', async () => {
    const twin = new DigitalTwinNetworking(baseConfig);
    const inquiry: IncomingInquiry = {
      senderId: 'sender-4',
      senderName: 'SpamBot',
      // Five spam keywords => spamScore = 1.0 => DROP
      messageContent: 'guaranteed roi buy now click here limited time investment opportunity',
      timestamp: new Date(),
    };
    const action = await twin.handleInquiry(inquiry);
    expect(action.action).toBe('DROP');
    expect(action.spamScore).toBeGreaterThan(0.85);
  });

  it('should draft outreach message', async () => {
    const twin = new DigitalTwinNetworking(baseConfig);
    const message = await twin.draftOutreach('target-user-456', 'Interested in collaboration');
    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(0);
  });
});
