import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@cogitator-ai/config';
import { createLLMBackend } from '@cogitator-ai/core';
import { CONFORMANCE_FIXTURE, ollamaWire, startFakeProvider } from '@cogitator-ai/test-utils';
import type { ChatRequest } from '@cogitator-ai/types';

describe('Config: Ollama headers reach the provider', () => {
  it.each(['chat', 'stream'] as const)('sends YAML-configured headers with %s', async (mode) => {
    const provider = await startFakeProvider();
    let directory: string | undefined;

    try {
      directory = mkdtempSync(join(tmpdir(), 'ollama-headers-e2e-'));
      provider.reply((request) => {
        const reply = ollamaWire.reply('text', mode, request);
        if (!reply) throw new Error('Missing Ollama text fixture');
        return reply;
      });

      const configPath = join(directory, 'cogitator.yml');
      writeFileSync(
        configPath,
        [
          'llm:',
          '  providers:',
          '    ollama:',
          `      baseUrl: ${provider.url}///`,
          '      apiKey: ollama-secret',
          '      headers:',
          '        X-Gateway-Key: gateway-secret',
          '        authorization: Bearer ignored',
        ].join('\n')
      );

      const config = loadConfig({ configPath, skipEnv: true });
      const backend = createLLMBackend('ollama', config.llm);
      const request: ChatRequest = {
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      if (mode === 'chat') {
        expect((await backend.chat(request)).content).toBe(CONFORMANCE_FIXTURE.text);
      } else {
        let output = '';
        for await (const chunk of backend.chatStream(request)) {
          output += chunk.delta.content ?? '';
        }
        expect(output).toBe(CONFORMANCE_FIXTURE.text);
      }

      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toMatchObject({
        method: 'POST',
        path: '/api/chat',
        headers: {
          'x-gateway-key': 'gateway-secret',
          authorization: 'Bearer ollama-secret',
          'content-type': 'application/json',
        },
        body: { stream: mode === 'stream' },
      });
    } finally {
      await provider.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
});
