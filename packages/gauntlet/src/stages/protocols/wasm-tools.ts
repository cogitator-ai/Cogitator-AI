import { createHash, createPublicKey, verify } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Agent } from '@cogitator-ai/core';
import type { Tool, ToolContext } from '@cogitator-ai/types';
import {
  createBase64Tool,
  createCalcTool,
  createCompressionTool,
  createCsvTool,
  createDatetimeTool,
  createHashTool,
  createJsonTool,
  createMarkdownTool,
  createRegexTool,
  createSigningTool,
  createSlugTool,
  createValidationTool,
  createXmlTool,
} from '@cogitator-ai/wasm-tools';
import type { StageContext, StageDefinition } from '../../runner/types.js';
import {
  CORE,
  SANDBOX,
  TYPES,
  WASM_TOOLS,
  assertCalled,
  calledTools,
  excerpt,
  within,
} from './shared.js';

/** DER prefix that turns a raw 32-byte Ed25519 public key into SPKI for node:crypto. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function toolContext(ctx: StageContext): ToolContext {
  return { agentId: 'gauntlet', runId: `gauntlet-${ctx.stageId}`, signal: ctx.signal };
}

/** Narrows a tool result to a record so fields can be compared. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected an object result, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function same(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** A tool whose own `execute` counts calls, to tell a sandboxed run from a direct one. */
function counted<TParams>(inner: Tool<TParams, unknown>): {
  tool: Tool<TParams, unknown>;
  calls: () => number;
} {
  let calls = 0;
  return {
    tool: {
      ...inner,
      execute: (params, context) => {
        calls++;
        return inner.execute(params, context);
      },
    },
    calls: () => calls,
  };
}

/**
 * The pre-built WASM tools run directly with results checked against node:crypto and zlib, a
 * runaway regex is cut off by the worker timeout, and an agent calls them through the sandbox.
 */
export const wasmToolsStage: StageDefinition = {
  id: 'wasm-tools',
  title: 'WASM tools',
  description:
    'Pre-built Extism tools compute verifiable results, a runaway regex is stopped by its timeout, and an agent calls them through the WASM sandbox.',
  packages: [WASM_TOOLS, SANDBOX, CORE, TYPES],
  needs: ['handshake'],
  timeoutMs: 150_000,
  async run(ctx) {
    const context = toolContext(ctx);

    await ctx.check('calculator evaluates an expression', async (evidence) => {
      const result = record(
        await createCalcTool().execute({ expression: '(17 + 25) * 3 - 7 % 4' }, context)
      );
      evidence('result', result);
      same(result.result, 123, 'calculate');
    });

    await ctx.check('hash matches node:crypto', async (evidence) => {
      const tool = createHashTool();
      for (const algorithm of ['sha256', 'sha1', 'md5'] as const) {
        const result = record(await tool.execute({ text: 'gauntlet', algorithm }, context));
        evidence(algorithm, result.hash);
        same(result.hash, createHash(algorithm).update('gauntlet').digest('hex'), algorithm);
      }
    });

    await ctx.check('base64 round-trips UTF-8', async (evidence) => {
      const tool = createBase64Tool();
      const text = 'gauntlet ✓ Привет';
      const encoded = record(await tool.execute({ text, operation: 'encode' }, context));
      evidence('encoded', encoded.result);
      same(encoded.result, Buffer.from(text).toString('base64'), 'encode');
      const decoded = record(
        await tool.execute({ text: String(encoded.result), operation: 'decode' }, context)
      );
      same(decoded.result, text, 'decode');
    });

    await ctx.check('text tools transform input', async (evidence) => {
      const slug = record(
        await createSlugTool().execute({ text: 'Привет мир, Crème brûlée!' }, context)
      );
      evidence('slug', slug.slug);
      same(slug.slug, 'privet-mir-creme-brulee', 'slug');

      const json = record(
        await createJsonTool().execute(
          {
            json: '{"crew":[{"name":"Ada","rank":3},{"name":"Lin","rank":5}]}',
            query: '$.crew[*].rank',
          },
          context
        )
      );
      evidence('jsonPath', json.result);
      same(json.result, [3, 5], 'JSONPath');

      const ip = record(
        await createValidationTool().execute(
          { value: '2001:DB8:0:0:0:0:0:1', type: 'ipv6' },
          context
        )
      );
      evidence('ipv6', ip.normalized);
      same([ip.valid, ip.normalized], [true, '2001:db8::1'], 'ipv6');

      const date = record(
        await createDatetimeTool().execute(
          { date: '2024-01-31', operation: 'add', amount: 1, unit: 'months' },
          context
        )
      );
      evidence('monthEnd', date.result);
      same(String(date.result).slice(0, 10), '2024-02-29', 'month clamping');
    });

    await ctx.check('structured formats parse', async (evidence) => {
      const csv = record(
        await createCsvTool().execute(
          { data: 'name,rank\nAda,3\n"Lin, Jr",5', operation: 'parse', headers: true },
          context
        )
      );
      evidence('csv', csv.result);
      same(
        csv.result,
        [
          ['Ada', '3'],
          ['Lin, Jr', '5'],
        ],
        'CSV'
      );

      const xml = record(
        await createXmlTool().execute(
          {
            xml: '<fleet><ship id="a">Vega</ship><ship id="b">Lyra</ship></fleet>',
            query: '//ship/@id',
          },
          context
        )
      );
      evidence('xml', xml.result);
      same(xml.result, ['a', 'b'], 'XPath attributes');

      const markdown = record(
        await createMarkdownTool().execute(
          { markdown: '# Gauntlet\n[x](javascript:alert(1))' },
          context
        )
      );
      evidence('html', markdown.html);
      const html = String(markdown.html);
      if (!html.includes('<h1>Gauntlet</h1>')) throw new Error('Heading was not rendered');
      if (html.includes('javascript:')) throw new Error('A javascript: link survived sanitizing');
    });

    await ctx.check('gzip interoperates with zlib', async (evidence) => {
      const tool = createCompressionTool();
      const text = 'gauntlet '.repeat(40);
      const compressed = record(
        await tool.execute({ data: text, operation: 'compress', level: 9 }, context)
      );
      evidence('ratio', compressed.ratio);
      same(
        gunzipSync(Buffer.from(String(compressed.result), 'base64')).toString(),
        text,
        'zlib gunzip'
      );
      const restored = record(
        await tool.execute({ data: String(compressed.result), operation: 'decompress' }, context)
      );
      same(restored.result, text, 'decompress');
    });

    await ctx.check('Ed25519 signatures verify in node:crypto', async (evidence) => {
      const tool = createSigningTool();
      const message = 'gauntlet run';
      const pair = record(
        await tool.execute({ operation: 'generateKeypair', algorithm: 'ed25519' }, context)
      );
      const signed = record(
        await tool.execute(
          { operation: 'sign', algorithm: 'ed25519', message, privateKey: String(pair.privateKey) },
          context
        )
      );
      const publicKey = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(String(pair.publicKey), 'hex')]),
        format: 'der',
        type: 'spki',
      });
      const nodeAccepts = verify(
        null,
        Buffer.from(message),
        publicKey,
        Buffer.from(String(signed.signature), 'hex')
      );
      const tampered = record(
        await tool.execute(
          {
            operation: 'verify',
            algorithm: 'ed25519',
            message: `${message}!`,
            publicKey: String(pair.publicKey),
            signature: String(signed.signature),
          },
          context
        )
      );
      evidence('publicKey', excerpt(String(pair.publicKey), 16));
      evidence('nodeAccepts', nodeAccepts);
      evidence('tamperedValid', tampered.valid);
      if (!nodeAccepts) throw new Error('node:crypto rejects the WASM signature');
      if (tampered.valid !== false) throw new Error('A tampered message verified');
    });

    await ctx.check('runaway regex is stopped by the timeout', async (evidence) => {
      const regex = createRegexTool({ timeout: 1_000 });
      const started = Date.now();
      const outcome = await within(
        10_000,
        'The regex call',
        regex
          .execute({ text: `${'a'.repeat(40)}b`, pattern: '(a|aa)+$', operation: 'test' }, context)
          .then(
            (value) => ({ rejected: false as const, value }),
            (error: unknown) => ({ rejected: true as const, error })
          )
      );
      evidence('elapsedMs', Date.now() - started);
      if (!outcome.rejected)
        throw new Error(`Expected a timeout, got ${JSON.stringify(outcome.value)}`);
      evidence(
        'error',
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
      );
      const after = record(
        await regex.execute({ text: 'wasm tools', pattern: '\\w+', operation: 'matchAll' }, context)
      );
      evidence('afterTimeout', after.matchCount);
      same(after.matchCount, 2, 'regex after a timeout');
    });

    await ctx.check('agent calls WASM tools through the sandbox', async (evidence) => {
      const calc = counted(createCalcTool());
      const hash = counted(createHashTool());
      const cogitator = ctx.createCogitator({ sandbox: { allowNativeFallback: false } });
      const agent = new Agent({
        name: 'wasm-analyst',
        model: ctx.model,
        instructions:
          'You never compute in your head. Use calculate for arithmetic and hash_text for hashes, then reply with both results on separate lines.',
        tools: [calc.tool, hash.tool],
        maxIterations: 5,
      });
      const run = await cogitator.run(agent, {
        input: 'Compute 48271 * 1307 - 9999, and the sha256 hash of the text "cogitator".',
        signal: ctx.signal,
      });
      const product = String(48271 * 1307 - 9999);
      const digest = createHash('sha256').update('cogitator').digest('hex');
      evidence('toolCalls', calledTools(run));
      evidence('directExecuteCalls', calc.calls() + hash.calls());
      evidence('output', excerpt(run.output));
      assertCalled(run, 'calculate');
      assertCalled(run, 'hash_text');
      if (calc.calls() + hash.calls() > 0) {
        throw new Error('The tools ran through their own execute instead of the WASM sandbox');
      }
      const digits = run.output.replace(/[,\s\u202f]/g, '');
      if (!digits.includes(product)) throw new Error(`The answer lacks ${product}`);
      if (!run.output.toLowerCase().includes(digest.slice(0, 16)))
        throw new Error('The answer lacks the hash');
    });
  },
};
