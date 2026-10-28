import { describe, expect, it } from 'vitest';
import {
  APP_SERVER_ERROR_CODES,
  APP_SERVER_METHODS,
  APP_SERVER_NOTIFICATIONS,
  APP_SERVER_SCHEMAS,
  APP_SERVER_SERVER_REQUESTS,
  ApprovalRequestResultSchema,
  InitializeParamsSchema,
  ReviewOutputSchema,
  ReviewStartParamsSchema,
  ThreadListParamsSchema,
  TurnEventNotificationSchema,
  TurnStartParamsSchema,
  TurnSteerParamsSchema,
  UserInputSchema,
} from '../protocol/index';

describe('app-server protocol', () => {
  it('keeps _meta and drops keys it does not know', () => {
    const parsed = TurnStartParamsSchema.parse({
      threadId: 't',
      input: [{ type: 'text', text: 'hi', _meta: { from: 'ui' } }],
      _meta: { trace: 'x' },
      later: true,
    });
    expect(parsed).toEqual({
      threadId: 't',
      input: [{ type: 'text', text: 'hi', _meta: { from: 'ui' } }],
      _meta: { trace: 'x' },
    });
  });

  it('reads text and both kinds of image input', () => {
    expect(UserInputSchema.parse({ type: 'image', url: 'https://x/y.png' })).toEqual({
      type: 'image',
      url: 'https://x/y.png',
    });
    expect(
      UserInputSchema.parse({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
    ).toMatchObject({ data: 'AAAA' });
    expect(UserInputSchema.safeParse({ type: 'image' }).success).toBe(false);
    expect(UserInputSchema.safeParse({ type: 'audio', url: 'x' }).success).toBe(false);
  });

  it('refuses empty input and an unknown delivery', () => {
    expect(TurnStartParamsSchema.safeParse({ threadId: 't', input: [] }).success).toBe(false);
    expect(
      TurnSteerParamsSchema.safeParse({
        threadId: 't',
        expectedTurnId: 'u',
        input: [{ type: 'text', text: 'x' }],
        delivery: 'later',
      }).success
    ).toBe(false);
  });

  it('reads every review target and checks findings', () => {
    for (const target of [
      { type: 'uncommittedChanges' },
      { type: 'baseBranch', branch: 'main' },
      { type: 'commit', sha: 'abc' },
      { type: 'custom', instructions: 'Look at auth' },
    ]) {
      expect(ReviewStartParamsSchema.safeParse({ threadId: 't', target }).success).toBe(true);
    }
    expect(
      ReviewStartParamsSchema.safeParse({ threadId: 't', target: { type: 'baseBranch' } }).success
    ).toBe(false);
    const finding = { title: 't', body: 'b', priority: 4, confidence: 0.5 };
    expect(
      ReviewOutputSchema.safeParse({
        findings: [finding],
        overallCorrectness: 'correct',
        overallExplanation: 'x',
      }).success
    ).toBe(false);
  });

  it('bounds the page size of thread/list', () => {
    expect(ThreadListParamsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(ThreadListParamsSchema.safeParse({ limit: 100 }).success).toBe(true);
  });

  it('reads the answers of approval/request in the form of ACP', () => {
    expect(
      ApprovalRequestResultSchema.parse({
        outcome: { outcome: 'selected', optionId: 'allow_once' },
      })
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    expect(ApprovalRequestResultSchema.parse({ outcome: { outcome: 'cancelled' } })).toBeTruthy();
    expect(
      ApprovalRequestResultSchema.safeParse({ outcome: { outcome: 'selected', optionId: 'maybe' } })
        .success
    ).toBe(false);
  });

  it('carries stream events in turn/event', () => {
    expect(
      TurnEventNotificationSchema.safeParse({
        threadId: 't',
        turnId: 'u',
        event: { type: 'text-delta', id: 'p', delta: 'hi' },
        parentToolCallId: 'c1',
        agent: 'researcher',
      }).success
    ).toBe(true);
    expect(
      TurnEventNotificationSchema.safeParse({ threadId: 't', turnId: 'u', event: { type: 'nope' } })
        .success
    ).toBe(false);
  });

  it('needs a protocol version and client info to initialize', () => {
    expect(InitializeParamsSchema.safeParse({ clientInfo: { name: 'x' } }).success).toBe(false);
    expect(
      InitializeParamsSchema.parse({
        protocolVersion: 1,
        clientInfo: { name: 'x' },
        capabilities: { approvals: 'request', optOutNotifications: ['thread/log'] },
      }).capabilities
    ).toEqual({ approvals: 'request', optOutNotifications: ['thread/log'] });
  });

  it('names every schema the methods and notifications use', () => {
    const named = new Set(APP_SERVER_SCHEMAS.map(([, schema]) => schema));
    for (const entry of [
      ...Object.values(APP_SERVER_METHODS),
      ...Object.values(APP_SERVER_SERVER_REQUESTS),
    ]) {
      expect(named.has(entry.params)).toBe(true);
      expect(named.has(entry.result)).toBe(true);
    }
    for (const schema of Object.values(APP_SERVER_NOTIFICATIONS)) {
      expect(named.has(schema)).toBe(true);
    }
    const names = APP_SERVER_SCHEMAS.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the error codes of the plan', () => {
    expect(APP_SERVER_ERROR_CODES).toMatchObject({
      invalidParams: -32602,
      notFound: -32002,
      notInitialized: -32010,
      alreadyInitialized: -32011,
      threadBusy: -32020,
      turnNotActive: -32021,
      threadPaused: -32022,
      threadArchived: -32023,
      runtimeError: -32030,
    });
  });
});
