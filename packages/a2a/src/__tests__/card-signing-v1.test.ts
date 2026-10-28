import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  canonicalizeAgentCard as sdkCanonicalize,
  verifyAgentCardSignature as sdkVerify,
  type AgentCard as SdkAgentCard,
} from '@a2a-js/sdk-v1';
import { A2AServer } from '../server';
import { A2AClient } from '../client';
import { verifyAgentCardSignature } from '../agent-card';
import {
  AgentCardSigner,
  canonicalizeAgentCard,
  legacyCoverageProblem,
  verifyAgentCardJws,
} from '../card-signing';
import type { AgentCardSigningAlgorithm, AgentCardSigningConfig } from '../types';
import type { V1AgentCard } from '../v1/types';
import { echoCogitator, mockAgent, serveExpress, type Served } from './v1-helpers';

interface KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

const KEYS: Record<AgentCardSigningAlgorithm, () => KeyPair> = {
  ES256: () => generateKeyPairSync('ec', { namedCurve: 'P-256' }),
  RS256: () => generateKeyPairSync('rsa', { modulusLength: 2048 }),
  PS256: () => generateKeyPairSync('rsa', { modulusLength: 2048 }),
  EdDSA: () => generateKeyPairSync('ed25519'),
};

function decodeHeader(encoded: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function signedServer(cardSigning: AgentCardSigningConfig): A2AServer {
  return new A2AServer({
    agents: { helper: mockAgent('helper') },
    cogitator: echoCogitator(),
    cardSigning,
  });
}

describe.each(Object.keys(KEYS) as AgentCardSigningAlgorithm[])(
  'Agent Card signing with %s',
  (alg) => {
    const { privateKey, publicKey } = KEYS[alg]();
    const inputs: Record<string, AgentCardSigningConfig['privateKey']> = {
      KeyObject: privateKey,
      PEM: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      JWK: privateKey.export({ format: 'jwk' }),
    };

    it.each(Object.keys(inputs))('signs with a %s private key', async (form) => {
      const server = signedServer({ alg, privateKey: inputs[form], kid: `${alg}-key` });
      const card = server.getV1AgentCard(undefined, { baseUrl: 'https://agents.example.com' });
      expect(card.signatures).toHaveLength(1);
      const [signature] = card.signatures!;
      expect(decodeHeader(signature.protected)).toEqual({ alg, typ: 'JOSE', kid: `${alg}-key` });

      await expect(
        sdkVerify(async () => publicKey)(card as unknown as SdkAgentCard)
      ).resolves.toBeUndefined();
      expect(await verifyAgentCardJws(card, { keys: { [`${alg}-key`]: publicKey } })).toBe(true);
    });

    it('puts the same signature on the hybrid card, which verifies too', async () => {
      const server = signedServer({ alg, privateKey, kid: 'k1' });
      const options = { baseUrl: 'https://agents.example.com' };
      const v1 = server.getV1AgentCard(undefined, options);
      const hybrid = server.getAgentCard(undefined, options);
      expect(hybrid.signatures).toEqual(v1.signatures);
      expect(await verifyAgentCardJws(hybrid, { keys: { k1: publicKey } })).toBe(true);
      expect(
        await verifyAgentCardJws({ ...hybrid, name: 'forged' }, { keys: { k1: publicKey } })
      ).toBe(false);
      expect(await verifyAgentCardJws(v1, { keys: { other: publicKey } })).toBe(false);
    });

    it('keeps the signature of an unchanged card, so its ETag stays', () => {
      const server = signedServer({ alg, privateKey, kid: 'k1' });
      expect(server.getV1AgentCard().signatures).toEqual(server.getV1AgentCard().signatures);
    });
  }
);

describe('Agent Card signing keys', () => {
  it('refuses a key that does not fit the algorithm', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(() => new AgentCardSigner({ alg: 'ES256', privateKey, kid: 'k' })).toThrow(/ES256/);
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey;
    expect(() => new AgentCardSigner({ alg: 'ES256', privateKey: p384, kid: 'k' })).toThrow(
      /P-256/
    );
    const { publicKey } = generateKeyPairSync('ed25519');
    expect(() => new AgentCardSigner({ alg: 'EdDSA', privateKey: publicKey, kid: 'k' })).toThrow(
      /private key/
    );
  });

  it('canonicalizes exactly as the official SDK', () => {
    const card: V1AgentCard = {
      name: 'Example Agent',
      description: '',
      supportedInterfaces: [
        {
          url: 'https://a.example',
          protocolBinding: 'JSONRPC',
          tenant: '',
          protocolVersion: '1.0',
        },
      ],
      version: '1.0.0',
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extensions: [{ uri: 'https://ext.example/v1', required: false, params: { a: '', b: 0 } }],
      },
      securitySchemes: {
        oauth: {
          oauth2SecurityScheme: {
            flows: {
              authorizationCode: {
                authorizationUrl: 'https://auth.example/authorize',
                tokenUrl: 'https://auth.example/token',
                scopes: {},
                pkceRequired: false,
              },
            },
          },
        },
      },
      securityRequirements: [{ schemes: { oauth: { list: [] } } }],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: [],
      skills: [{ id: 's', name: 'S', description: 'd', tags: ['t'], examples: [] }],
    };
    expect(canonicalizeAgentCard(card)).toBe(sdkCanonicalize(card as unknown as SdkAgentCard));
  });
});

describe('JWKS and jku', () => {
  let served: Served | undefined;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  afterEach(async () => {
    await served?.close();
    served = undefined;
  });

  it('publishes the public key at /.well-known/jwks.json', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      cardSigning: { alg: 'ES256', privateKey, kid: 'card-1', publishJwks: true },
    });
    const response = await fetch(`${served.url}/.well-known/jwks.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/jwk-set+json');
    const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
    expect(jwks.keys).toEqual([
      { ...publicKey.export({ format: 'jwk' }), kid: 'card-1', alg: 'ES256', use: 'sig' },
    ]);
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });

  it('does not serve a JWKS unless asked to', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      cardSigning: { alg: 'ES256', privateKey, kid: 'card-1' },
    });
    expect((await fetch(`${served.url}/.well-known/jwks.json`)).status).toBe(404);
  });

  it('lets the client fetch a cross-origin jku only when it trusts that origin', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      cardSigning: { alg: 'ES256', privateKey, kid: 'card-1', publishJwks: true },
    });
    const elsewhere = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      cardSigning: {
        alg: 'ES256',
        privateKey,
        kid: 'card-1',
        jku: `${served.url}/.well-known/jwks.json`,
      },
    });
    try {
      const client = new A2AClient(elsewhere.url);
      expect(await client.verifyAgentCard({})).toBe(false);
      expect(await client.verifyAgentCard({ trustJku: [served.url] })).toBe(true);
      expect(await client.verifyAgentCard({ keys: { 'card-1': publicKey } })).toBe(true);
      expect(
        await client.verifyAgentCard({
          resolveKey: (kid) => (kid === 'card-1' ? publicKey : undefined),
        })
      ).toBe(true);
    } finally {
      await elsewhere.close();
    }
  });

  it('fetches a jku on the origin the card came from by default', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      cardSigning: { alg: 'ES256', privateKey, kid: 'card-1', publishJwks: true },
    });
    const card = served.server.getV1AgentCard(undefined, { baseUrl: served.url });
    const signature = new AgentCardSigner({
      alg: 'ES256',
      privateKey,
      kid: 'card-1',
      jku: `${served.url}/.well-known/jwks.json`,
    }).signature(card);
    const signed = { ...card, signatures: [signature] };
    expect(
      await verifyAgentCardJws(signed, { cardUrl: `${served.url}/.well-known/agent-card.json` })
    ).toBe(true);
    expect(
      await verifyAgentCardJws(signed, { cardUrl: 'https://elsewhere.example/card.json' })
    ).toBe(false);
  });
});

describe('HS256 signing, deprecated', () => {
  it('still signs and verifies both card versions with the shared secret', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      cardSigning: { secret: 'shared' },
    });
    const hybrid = server.getAgentCard();
    const v1 = server.getV1AgentCard();
    expect(verifyAgentCardSignature(hybrid, 'shared')).toBe(true);
    expect(verifyAgentCardSignature(v1, 'shared')).toBe(true);
    expect(verifyAgentCardSignature(v1, 'wrong')).toBe(false);
    expect(await verifyAgentCardJws(v1, { keys: {} })).toBe(false);
  });
});

describe('signatures over the 0.3 fields of a card', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keys = { k1: publicKey };
  const options = { baseUrl: 'https://agents.example.com' };

  function signedHybrid() {
    return signedServer({ alg: 'ES256', privateKey, kid: 'k1' }).getAgentCard(undefined, options);
  }

  it('verifies the hybrid card only while its 0.3 endpoints are signed 0.3 interfaces', async () => {
    const card = signedHybrid();
    expect(legacyCoverageProblem(card)).toBeUndefined();
    expect(await verifyAgentCardJws(card, { keys })).toBe(true);

    const tampered = [
      { ...card, url: 'https://evil.example/a2a' },
      { ...card, preferredTransport: 'HTTP+JSON' },
      { ...card, protocolVersion: '1.0' },
      {
        ...card,
        additionalInterfaces: [
          ...(card.additionalInterfaces ?? []),
          { transport: 'JSONRPC', url: 'https://evil.example/a2a' },
        ],
      },
      { ...card, capabilities: { ...card.capabilities, stateTransitionHistory: true } },
    ];
    for (const forged of tampered) {
      expect(await verifyAgentCardJws(forged, { keys })).toBe(false);
    }
  });

  it('does not verify a card whose OAuth flows the 1.0 form cannot hold', async () => {
    const card = signedHybrid();
    const oauth = {
      type: 'oauth2' as const,
      flows: {
        clientCredentials: { tokenUrl: 'https://auth.example/token', scopes: {} },
      },
    };
    const single = { ...card, securitySchemes: { oauth } };
    const resigned = {
      ...single,
      signatures: [new AgentCardSigner({ alg: 'ES256', privateKey, kid: 'k1' }).signature(single)],
    };
    expect(await verifyAgentCardJws(resigned, { keys })).toBe(true);

    const secondFlow = {
      ...resigned,
      securitySchemes: {
        oauth: {
          ...oauth,
          flows: {
            ...oauth.flows,
            password: { tokenUrl: 'https://evil.example/token', scopes: {} },
          },
        },
      },
    };
    expect(await verifyAgentCardJws(secondFlow, { keys })).toBe(false);
    const withoutFlows = { ...resigned, securitySchemes: { oauth: { ...oauth, flows: {} } } };
    expect(await verifyAgentCardJws(withoutFlows, { keys })).toBe(false);
  });

  it('refuses to sign a card its 1.0 form would not cover', () => {
    const signer = new AgentCardSigner({ alg: 'ES256', privateKey, kid: 'k1' });
    const card = signedHybrid();
    expect(() =>
      signer.signature({
        ...card,
        securitySchemes: {
          oauth: {
            type: 'oauth2',
            flows: {
              clientCredentials: { tokenUrl: 'https://auth.example/token', scopes: {} },
              password: { tokenUrl: 'https://auth.example/token', scopes: {} },
            },
          },
        },
      })
    ).toThrow(/security scheme oauth has no lossless A2A 1.0 form/);
    expect(() => signer.signature({ ...card, url: 'https://elsewhere.example' })).toThrow(
      /is not a 0.3 interface/
    );
  });

  it('signs a plain 0.3 card, whose endpoints are its 1.0 interfaces', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      protocolVersions: ['0.3'],
      cardSigning: {
        alg: 'EdDSA',
        privateKey: generateKeyPairSync('ed25519').privateKey,
        kid: 'e',
      },
    });
    const card = server.getAgentCard(undefined, options);
    expect(card.supportedInterfaces).toBeUndefined();
    expect(card.signatures).toHaveLength(1);
    expect(legacyCoverageProblem(card)).toBeUndefined();
  });

  it('serves the 0.3 form of a 1.0-only server unsigned', () => {
    const server = new A2AServer({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      protocolVersions: ['1.0'],
      cardSigning: { alg: 'ES256', privateKey, kid: 'k1' },
    });
    expect(server.getAgentCard().signatures).toBeUndefined();
    expect(server.getV1AgentCard().signatures).toHaveLength(1);
  });
});
