import { describe, it, expect, vi, beforeEach } from 'vitest';

const clientConfigs: Record<string, unknown>[] = [];

class MockBedrockRuntimeClient {
  constructor(config: Record<string, unknown>) {
    clientConfigs.push(config);
  }
  send = vi.fn().mockResolvedValue({
    output: { message: { content: [{ text: 'ok' }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
}

class MockConverseCommand {
  constructor(public input: unknown) {}
}

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: MockBedrockRuntimeClient,
  ConverseCommand: MockConverseCommand,
  ConverseStreamCommand: MockConverseCommand,
}));

import { BedrockBackend } from '../llm/bedrock';
import { createLLMBackend } from '../llm/index';
import type { LLMBackend } from '@cogitator-ai/types';

async function clientConfigOf(backend: LLMBackend): Promise<Record<string, unknown>> {
  await backend.chat({
    model: 'anthropic.claude-sonnet',
    messages: [{ role: 'user', content: 'hi' }],
  });
  const config = clientConfigs.at(-1);
  if (!config) throw new Error('No Bedrock client was created');
  return config;
}

describe('Bedrock credentials', () => {
  beforeEach(() => {
    clientConfigs.length = 0;
  });

  it('sends the session token of temporary credentials with the static keys', async () => {
    const config = await clientConfigOf(
      new BedrockBackend({
        region: 'us-east-1',
        accessKeyId: 'ASIA-temp',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      })
    );
    expect(config.credentials).toEqual({
      accessKeyId: 'ASIA-temp',
      secretAccessKey: 'secret',
      sessionToken: 'token',
    });
  });

  it('passes a named profile to the SDK when no static keys are set', async () => {
    const config = await clientConfigOf(new BedrockBackend({ region: 'us-east-1', profile: 'ci' }));
    expect(config.profile).toBe('ci');
    expect(config.credentials).toBeUndefined();
  });

  it('leaves credentials to the SDK chain when none are configured', async () => {
    const config = await clientConfigOf(new BedrockBackend({}));
    expect(config).not.toHaveProperty('credentials');
    expect(config).not.toHaveProperty('profile');
  });

  it('createLLMBackend forwards the session token and profile from llm.providers.bedrock', async () => {
    const config = await clientConfigOf(
      createLLMBackend('bedrock', {
        providers: {
          bedrock: {
            accessKeyId: 'ASIA-temp',
            secretAccessKey: 'secret',
            sessionToken: 'token',
            profile: 'ci',
          },
        },
      })
    );
    expect(config.credentials).toEqual({
      accessKeyId: 'ASIA-temp',
      secretAccessKey: 'secret',
      sessionToken: 'token',
    });
    expect(config.profile).toBe('ci');
  });
});
