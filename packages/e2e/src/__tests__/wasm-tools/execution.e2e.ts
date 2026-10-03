import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { statSync } from 'node:fs';
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  createBase64Tool,
  createCalcTool,
  createCompressionTool,
  createCsvTool,
  createDatetimeTool,
  createDiffTool,
  createHashTool,
  createJsonTool,
  createMarkdownTool,
  createRegexTool,
  createSigningTool,
  createSlugTool,
  createValidationTool,
  createXmlTool,
  getWasmPath,
} from '@cogitator-ai/wasm-tools';
import { SandboxManager } from '@cogitator-ai/sandbox';
import { Agent, Cogitator } from '@cogitator-ai/core';
import type { Tool, ToolContext } from '@cogitator-ai/types';
import { getTestModel, isOllamaRunning } from '../../helpers/setup';

function wasmBuilt(): boolean {
  try {
    return statSync(getWasmPath('calc')).size > 0;
  } catch {
    return false;
  }
}

const describeIfWasm = wasmBuilt() ? describe : describe.skip;

function context(signal: AbortSignal = AbortSignal.timeout(60_000)): ToolContext {
  return { agentId: 'e2e-wasm', runId: 'e2e-wasm-run', signal };
}

async function run<T>(tool: Pick<Tool<never>, 'execute'>, params: unknown): Promise<T> {
  return (await tool.execute(params as never, context())) as T;
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

describeIfWasm('WASM Tools: real execution (tool.execute)', () => {
  it('calc evaluates expressions and reports errors', async () => {
    expect(await run(createCalcTool(), { expression: '(2 + 3) * 4 - 10 % 4' })).toEqual({
      result: 18,
      expression: '(2 + 3) * 4 - 10 % 4',
    });
    expect(await run(createCalcTool(), { expression: '1/0' })).toMatchObject({
      error: 'Division by zero',
    });
  });

  it('hash matches node:crypto for unicode input', async () => {
    const text = 'Привет 😀';
    for (const algorithm of ['md5', 'sha1', 'sha256'] as const) {
      const out = await run<{ hash: string }>(createHashTool(), { text, algorithm });
      expect(out.hash).toBe(createHash(algorithm).update(text, 'utf8').digest('hex'));
    }
  });

  it('base64 round-trips and rejects garbage', async () => {
    const encoded = await run<{ result: string }>(createBase64Tool(), {
      text: 'héllo wörld?',
      operation: 'encode',
      urlSafe: true,
    });
    expect(encoded.result).toBe(Buffer.from('héllo wörld?').toString('base64url'));
    const decoded = await run<{ result: string }>(createBase64Tool(), {
      text: encoded.result,
      operation: 'decode',
    });
    expect(decoded.result).toBe('héllo wörld?');
    expect(
      await run<{ error?: string }>(createBase64Tool(), { text: '!!!', operation: 'decode' })
    ).toMatchObject({ error: expect.stringContaining('Invalid base64') });
  });

  it('json supports wildcard JSONPath queries', async () => {
    const out = await run(createJsonTool(), {
      json: JSON.stringify({ items: [{ id: 1 }, { id: 2 }] }),
      query: '$.items[*].id',
    });
    expect(out).toEqual({ result: [1, 2], type: 'array', found: true });
  });

  it('compression interoperates with zlib in both directions', async () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(50);
    const compressed = await run<{ result: string }>(createCompressionTool(), {
      data: text,
      operation: 'compress',
    });
    expect(gunzipSync(Buffer.from(compressed.result, 'base64')).toString()).toBe(text);

    const restored = await run<{ result: string }>(createCompressionTool(), {
      data: gzipSync(text).toString('base64'),
      operation: 'decompress',
    });
    expect(restored.result).toBe(text);
  });

  it('signing generates keys with a host-provided seed and signs verifiably', async () => {
    const keys = await run<{ privateKey: string; publicKey: string }>(createSigningTool(), {
      operation: 'generateKeypair',
      algorithm: 'ed25519',
    });
    expect(keys.privateKey).toMatch(/^[0-9a-f]{64}$/);

    const signed = await run<{ signature: string }>(createSigningTool(), {
      operation: 'sign',
      algorithm: 'ed25519',
      privateKey: keys.privateKey,
      message: 'cogitator',
    });
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(keys.publicKey, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    expect(
      nodeVerify(null, Buffer.from('cogitator'), publicKey, Buffer.from(signed.signature, 'hex'))
    ).toBe(true);
  });

  it('markdown neutralizes javascript: links', async () => {
    const out = await run<{ html: string }>(createMarkdownTool(), {
      markdown: '# T\n\n[x](javascript:alert(1)) **b**',
    });
    expect(out.html).toBe('<h1>T</h1>\n<p><a href="#">x</a> <strong>b</strong></p>');
  });

  it('xml, csv, datetime, diff, slug and validation produce correct results', async () => {
    expect(
      await run(createXmlTool(), { xml: '<a><b>1</b><c><b>2</b></c></a>', query: '//b/text()' })
    ).toEqual({ result: ['1', '2'], type: 'array' });
    expect(
      await run(createCsvTool(), { data: 'n,v\n"a,b",1', operation: 'parse', headers: true })
    ).toMatchObject({ result: [['a,b', '1']], headers: ['n', 'v'] });
    expect(
      await run(createDatetimeTool(), {
        date: '2024-01-31',
        operation: 'add',
        amount: 1,
        unit: 'months',
      })
    ).toMatchObject({ result: '2024-02-29T00:00:00.000Z' });
    expect(await run(createDiffTool(), { original: 'a\nb', modified: 'a\nc' })).toMatchObject({
      diff: '--- original\n+++ modified\n@@ -1,2 +1,2 @@\n a\n-b\n+c',
    });
    expect(await run(createSlugTool(), { text: 'Crème brûlée, hello/world' })).toMatchObject({
      slug: 'creme-brulee-hello-world',
    });
    expect(
      await run(createValidationTool(), { value: '2001:DB8:0:0:0:0:0:1', type: 'ipv6' })
    ).toMatchObject({ valid: true, normalized: '2001:db8::1' });
  });

  it('regex rejects nested quantifiers and the timeout stops other catastrophic patterns', async () => {
    expect(
      await run(createRegexTool(), { text: 'aaaa', pattern: '(a+)+$', operation: 'test' })
    ).toMatchObject({ error: expect.stringContaining('ReDoS') });

    const started = Date.now();
    await expect(
      run(createRegexTool({ timeout: 500 }), {
        text: `${'a'.repeat(40)}!`,
        pattern: '(a|aa)+$',
        operation: 'test',
      })
    ).rejects.toThrow('timed out after 500ms');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('honours an aborted tool context', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createCalcTool().execute({ expression: '1+1' }, context(controller.signal))
    ).rejects.toThrow('aborted');
  });
});

describeIfWasm('WASM Tools: execution through @cogitator-ai/sandbox', () => {
  let manager: SandboxManager;

  beforeAll(async () => {
    manager = new SandboxManager();
    await manager.initialize();
  });

  afterAll(async () => {
    await manager.shutdown();
  });

  it('runs pre-built tools with their sandbox config', async () => {
    const hashTool = createHashTool();
    const result = await manager.execute(
      { command: [], stdin: JSON.stringify({ text: 'abc', algorithm: 'sha256' }), timeout: 10_000 },
      hashTool.sandbox!
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(JSON.parse(result.data.stdout)).toEqual({
        hash: createHash('sha256').update('abc').digest('hex'),
        algorithm: 'sha256',
      });
    }
  });

  it('receives the host-generated signing seed from schema validation', async () => {
    const signingTool = createSigningTool();
    const args = signingTool.parameters.parse({
      operation: 'generateKeypair',
      algorithm: 'ed25519',
    });
    const result = await manager.execute(
      { command: [], stdin: JSON.stringify(args), timeout: 20_000 },
      signingTool.sandbox!
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(JSON.parse(result.data.stdout)).toMatchObject({
        privateKey: (args as { seed: string }).seed,
        publicKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }
  });
});

const describeIfAgent =
  wasmBuilt() && process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeIfAgent('WASM Tools: agent integration (Ollama)', () => {
  let cogitator: Cogitator;
  let available = false;

  beforeAll(async () => {
    available = await isOllamaRunning();
    cogitator = new Cogitator({ llm: { defaultModel: `ollama/${getTestModel()}` } });
  });

  afterAll(async () => {
    await cogitator?.close();
  });

  it('agent calls the WASM calculator and receives its real result', async () => {
    if (!available) return;
    const agent = new Agent({
      name: 'wasm-calculator',
      model: `ollama/${getTestModel()}`,
      instructions:
        'You are a calculator assistant. Always use the calculate tool for arithmetic, then answer with the number.',
      tools: [createCalcTool()],
      maxIterations: 4,
      temperature: 0,
    });

    let toolMessage: string | undefined;
    for (let attempt = 0; attempt < 3 && !toolMessage; attempt++) {
      const result = await cogitator.run(agent, {
        input: 'Use the calculate tool to compute 1234 * 5678.',
      });
      const calculateCall = result.toolCalls.find((call) => call.name === 'calculate');
      if (!calculateCall) continue;
      const message = result.messages.find(
        (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('result')
      );
      toolMessage = typeof message?.content === 'string' ? message.content : undefined;
    }

    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage!) as { result: number | null; expression: string };
    expect(parsed.expression).toBeTruthy();
    expect(parsed.result).not.toBeNull();
  });
});

describe('WASM Tools: placeholder builds', () => {
  it('reports a clear error when the WASM binaries were not built', async () => {
    if (wasmBuilt()) return;
    await expect(createCalcTool().execute({ expression: '1+1' }, context())).rejects.toThrow(
      'placeholder'
    );
  });
});
