import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { verifyAgentCardSignature, type AgentCard as SdkAgentCard } from '@a2a-js/sdk-v1';
import { A2AClient, type JsonWebKeySet, type V1AgentCard } from '@cogitator-ai/a2a';
import type { Cogitator } from '@cogitator-ai/core';
import { createTestCogitator, createTestAgent, ollamaSkipReason } from '../../helpers/setup';
import { asTask, startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';

const describeE2E = describe.skipIf((await ollamaSkipReason()) !== null);

describeE2E('A2A 1.0: signed Agent Cards', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  beforeAll(async () => {
    cogitator = createTestCogitator();
    testServer = await startTestA2AServer({
      agents: {
        signer: createTestAgent({
          name: 'signer',
          instructions: 'Answer in one short sentence.',
          maxTokens: 64,
        }),
      },
      cogitator,
      cardSigning: { alg: 'EdDSA', privateKey, kid: 'e2e-key', publishJwks: true },
    });
  });

  afterAll(async () => {
    await testServer?.close();
    await cogitator?.close();
  });

  it('signs the 1.0 card so the official SDK verifies it', async () => {
    const card = (await (
      await fetch(`${testServer.url}/.well-known/agent-card.json`, {
        headers: { 'A2A-Version': '1.0' },
      })
    ).json()) as V1AgentCard;
    await expect(
      verifyAgentCardSignature(async () => publicKey)(card as unknown as SdkAgentCard)
    ).resolves.toBeUndefined();
  });

  it('publishes the key as a JWKS the client verifies the card with', async () => {
    const jwks = (await (
      await fetch(`${testServer.url}/.well-known/jwks.json`)
    ).json()) as JsonWebKeySet;
    expect(jwks.keys[0].kid).toBe('e2e-key');

    const client = new A2AClient(testServer.url);
    expect(await client.verifyAgentCard({ keys: jwks })).toBe(true);
    expect(await client.verifyAgentCard({ keys: {} })).toBe(false);

    const task = asTask(
      await client.sendMessage({ role: 'user', parts: [{ kind: 'text', text: 'Hello.' }] })
    );
    expect(task.status.state).toBe('completed');
  });

  it('serves a stable ETag for the signed card', async () => {
    const url = `${testServer.url}/.well-known/agent-card.json`;
    const first = await fetch(url);
    const etag = first.headers.get('etag')!;
    const again = await fetch(url, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
  });
});
