import { describe, it, expect, vi } from 'vitest';
import {
  createWarnOnce,
  forcedToolChoiceInstruction,
  getClaudeSamplingPolicy,
  jsonOutputInstruction,
  mapClaudeStopReason,
  parseClaudeModelId,
  resolveClaudeSampling,
  supportsBedrockStructuredOutput,
  supportsForcedToolChoice,
  supportsNativeStructuredOutput,
} from '../llm/claude-models';
import { getLogger } from '../logger';

describe('parseClaudeModelId', () => {
  it.each([
    ['claude-sonnet-5-5', { family: 'sonnet', major: 5, minor: 5 }],
    ['claude-opus-5', { family: 'opus', major: 5, minor: 0 }],
    ['claude-fable-5-1', { family: 'fable', major: 5, minor: 1 }],
    ['claude-haiku-4-5-20251001', { family: 'haiku', major: 4, minor: 5 }],
    ['claude-haiku-4-5@20251001', { family: 'haiku', major: 4, minor: 5 }],
    ['claude-sonnet-4-20250514', { family: 'sonnet', major: 4, minor: 0 }],
    ['claude-opus-4-1-20250805', { family: 'opus', major: 4, minor: 1 }],
    ['claude-opus-4.8', { family: 'opus', major: 4, minor: 8 }],
    ['claude-opus-4-6[1m]', { family: 'opus', major: 4, minor: 6 }],
    ['claude-3-5-sonnet-20241022', { family: 'sonnet', major: 3, minor: 5 }],
    ['claude-3.7-sonnet', { family: 'sonnet', major: 3, minor: 7 }],
    ['claude-3-haiku-20240307', { family: 'haiku', major: 3, minor: 0 }],
    ['claude-mythos-preview', { family: 'mythos', major: null, minor: 0 }],
    ['anthropic.claude-sonnet-5-5', { family: 'sonnet', major: 5, minor: 5 }],
    ['global.anthropic.claude-opus-5-5', { family: 'opus', major: 5, minor: 5 }],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', { family: 'sonnet', major: 4, minor: 5 }],
    [
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-7',
      { family: 'opus', major: 4, minor: 7 },
    ],
  ])('parses %s', (id, expected) => {
    expect(parseClaudeModelId(id)).toEqual(expected);
  });

  it.each(['gpt-4o', 'meta.llama3-3-70b-instruct-v1:0', 'amazon.nova-pro-v1:0', 'claude-2.1', ''])(
    'returns null for %s',
    (id) => {
      expect(parseClaudeModelId(id)).toBeNull();
    }
  );
});

describe('getClaudeSamplingPolicy', () => {
  it.each([
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-mythos-5-1',
    'claude-mythos-preview',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-haiku-6',
    'anthropic.claude-sonnet-5-5',
  ])('%s rejects sampling params', (id) => {
    expect(getClaudeSamplingPolicy(id)).toBe('unsupported');
  });

  it.each([
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-1-20250805',
    'claude-sonnet-4-20250514',
  ])('%s accepts only one of temperature/top_p', (id) => {
    expect(getClaudeSamplingPolicy(id)).toBe('exclusive');
  });

  it.each(['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307', 'gpt-4o', 'claude-2.1'])(
    '%s accepts both',
    (id) => {
      expect(getClaudeSamplingPolicy(id)).toBe('unrestricted');
    }
  );
});

describe('resolveClaudeSampling', () => {
  it('drops everything for models that reject sampling params', () => {
    expect(resolveClaudeSampling('claude-opus-5-5', { temperature: 0.7, topP: 0.9 })).toEqual({});
  });

  it('keeps temperature over topP for exclusive models', () => {
    expect(resolveClaudeSampling('claude-sonnet-4-6', { temperature: 0.7, topP: 0.9 })).toEqual({
      temperature: 0.7,
    });
  });

  it('keeps topP alone for exclusive models when temperature is unset', () => {
    expect(resolveClaudeSampling('claude-haiku-4-5', { topP: 0.9 })).toEqual({ topP: 0.9 });
  });

  it('passes both through for unrestricted models', () => {
    expect(resolveClaudeSampling('gpt-4o', { temperature: 0, topP: 1 })).toEqual({
      temperature: 0,
      topP: 1,
    });
  });

  it('never invents values', () => {
    expect(resolveClaudeSampling('claude-3-5-sonnet-20241022', {})).toEqual({});
  });
});

describe('mapClaudeStopReason', () => {
  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['tool_use', 'tool_calls'],
    ['max_tokens', 'length'],
    ['model_context_window_exceeded', 'length'],
    ['pause_turn', 'length'],
    ['refusal', 'error'],
    ['guardrail_intervened', 'error'],
    ['content_filtered', 'error'],
    ['malformed_tool_use', 'error'],
    [null, 'stop'],
    [undefined, 'stop'],
  ])('maps %s to %s', (reason, expected) => {
    expect(mapClaudeStopReason(reason)).toBe(expected);
  });
});

describe('supportsForcedToolChoice', () => {
  it.each([
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-fable-5-1',
    'claude-mythos-5-1',
    'claude-opus-6',
    'global.anthropic.claude-sonnet-5-5',
  ])('%s rejects forced tool use', (id) => {
    expect(supportsForcedToolChoice(id)).toBe(false);
  });

  it.each([
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-mythos-5',
    'claude-mythos-preview',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-3-5-sonnet-20241022',
    'gpt-4o',
  ])('%s accepts forced tool use', (id) => {
    expect(supportsForcedToolChoice(id)).toBe(true);
  });
});

describe('supportsNativeStructuredOutput', () => {
  it.each([
    'claude-fable-5-1',
    'claude-mythos-preview',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-opus-4-8',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001',
  ])('%s supports output_config.format', (id) => {
    expect(supportsNativeStructuredOutput(id)).toBe(true);
  });

  it.each(['claude-opus-4-1-20250805', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet', 'gpt-4o'])(
    '%s does not',
    (id) => {
      expect(supportsNativeStructuredOutput(id)).toBe(false);
    }
  );
});

describe('supportsBedrockStructuredOutput', () => {
  it.each([
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'anthropic.claude-haiku-4-5-20251001-v1:0',
    'anthropic.claude-opus-4-5-20251101-v1:0',
    'global.anthropic.claude-opus-4-6-v1',
    'anthropic.claude-sonnet-4-6',
  ])('%s supports outputConfig.textFormat', (id) => {
    expect(supportsBedrockStructuredOutput(id)).toBe(true);
  });

  it.each([
    'anthropic.claude-opus-4-7',
    'global.anthropic.claude-sonnet-5-5',
    'anthropic.claude-fable-5-1',
    'anthropic.claude-mythos-preview',
    'anthropic.claude-3-5-sonnet-20241022-v2:0',
    'meta.llama3-3-70b-instruct-v1:0',
  ])('%s does not', (id) => {
    expect(supportsBedrockStructuredOutput(id)).toBe(false);
  });
});

describe('createWarnOnce', () => {
  it('logs each key once per instance', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    const warnOnce = createWarnOnce();

    warnOnce('a', 'first', { n: 1 });
    warnOnce('a', 'first again');
    warnOnce('b', 'second');
    createWarnOnce()('a', 'other instance');

    expect(warn.mock.calls).toEqual([
      ['first', { n: 1 }],
      ['second', undefined],
      ['other instance', undefined],
    ]);
    warn.mockRestore();
  });
});

describe('instructions', () => {
  it('names the forced tool when known', () => {
    expect(forcedToolChoiceInstruction('search')).toBe(
      'You must respond by calling the "search" tool.'
    );
    expect(forcedToolChoiceInstruction()).toBe(
      'You must respond by calling one of the provided tools.'
    );
  });

  it('embeds the schema in the JSON instruction', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(jsonOutputInstruction(schema)).toContain(JSON.stringify(schema));
    expect(jsonOutputInstruction()).toBe(
      'You must respond with valid JSON only. Do not include any text before or after the JSON object.'
    );
  });
});
