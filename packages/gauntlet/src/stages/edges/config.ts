import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, loadDotenvFile, loadYamlConfig } from '@cogitator-ai/config';
import { Agent, Cogitator, registerLLMBackend, unregisterLLMBackend } from '@cogitator-ai/core';
import { BUILTIN_MODELS, ModelRegistry, type ModelInfo } from '@cogitator-ai/models';
import type { ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { fetchModelCatalogue, fetchPriceRange } from '../../llm.js';
import type { StageDefinition } from '../../runner/types.js';

const CONFIG = '@cogitator-ai/config';
const MODELS = '@cogitator-ai/models';
const CORE = '@cogitator-ai/core';

/** Name of the backend plugin the YAML file configures through `llm.plugins`. */
const YAML_PLUGIN = 'gauntlet-yaml';

const COGITATOR_YML = `# Written by the gauntlet: every value a user would keep in cogitator.yml.
llm:
  defaultModel: \${GAUNTLET_CONFIG_MODEL}
  retry:
    maxRetries: 1
    baseDelay: 500
  plugins:
    ${YAML_PLUGIN}:
      greeting: \${GAUNTLET_CONFIG_GREETING:-greetings from the yaml default}
      price: $$5
limits:
  maxConcurrentRuns: 2
  defaultTimeout: 90000
memory:
  adapter: memory
  inMemory:
    maxEntries: 200
logging:
  level: warn
  format: json
deploy:
  target: docker
  port: 8080
`;

interface PluginSettings {
  greeting: string;
  price: string;
}

function isPluginSettings(value: unknown): value is PluginSettings {
  return (
    typeof value === 'object' &&
    value !== null &&
    'greeting' in value &&
    typeof value.greeting === 'string' &&
    'price' in value &&
    typeof value.price === 'string'
  );
}

/** A backend built from YAML settings alone: it answers with the greeting it was configured with. */
function greetingBackend(settings: PluginSettings): LLMBackend {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  return {
    provider: YAML_PLUGIN,
    async chat(): Promise<ChatResponse> {
      return { id: 'yaml-1', content: settings.greeting, finishReason: 'stop', usage };
    },
    async *chatStream(): AsyncGenerator<ChatStreamChunk> {
      yield { id: 'yaml-1', delta: { content: settings.greeting }, finishReason: 'stop', usage };
    },
  };
}

/**
 * Sets environment variables for one synchronous call and restores them afterwards, so no
 * other stage ever observes them.
 */
function withEnv<T>(values: Record<string, string>, run: () => T): T {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Proves a YAML file with env references, env overrides and code overrides builds a working runtime. */
const configYaml: StageDefinition = {
  id: 'config-yaml',
  title: 'Config from YAML',
  description:
    'A cogitator.yml with env references and COGITATOR_* overrides loads, validates and drives a runtime: the YAML model answers, YAML memory remembers, and a YAML-configured backend plugin serves runs.',
  packages: [CONFIG, CORE],
  needs: ['handshake'],
  timeoutMs: 120_000,
  async run(ctx) {
    const configPath = join(ctx.tmpDir, 'cogitator.yml');
    const dotenvPath = join(ctx.tmpDir, '.env');
    await writeFile(configPath, COGITATOR_YML);
    await writeFile(
      dotenvPath,
      [
        '# project secrets',
        'export GAUNTLET_CONFIG_GREETING="hello from dotenv # not a comment"',
        '',
      ].join('\n')
    );

    await ctx.check('dotenv and ${VAR} interpolation', (evidence) => {
      const dotenv = loadDotenvFile(dotenvPath);
      evidence('dotenvKeys', Object.keys(dotenv));
      const fromDotenv = loadYamlConfig(configPath, {
        ...dotenv,
        GAUNTLET_CONFIG_MODEL: ctx.model,
      });
      const withDefaults = loadYamlConfig(configPath, { GAUNTLET_CONFIG_MODEL: ctx.model });
      const greeting = fromDotenv?.llm?.plugins?.[YAML_PLUGIN];
      const fallback = withDefaults?.llm?.plugins?.[YAML_PLUGIN];
      evidence('interpolated', greeting);
      evidence('fallback', fallback);
      if (
        !isPluginSettings(greeting) ||
        greeting.greeting !== 'hello from dotenv # not a comment'
      ) {
        throw new Error(
          'The .env value did not reach the YAML through ${GAUNTLET_CONFIG_GREETING}'
        );
      }
      if (!isPluginSettings(fallback) || fallback.greeting !== 'greetings from the yaml default') {
        throw new Error('${VAR:-default} did not fall back to its default');
      }
      if (greeting.price !== '$5') {
        throw new Error(`$$ did not escape to a literal $: ${greeting.price}`);
      }
      if (fromDotenv?.llm?.defaultModel !== ctx.model) {
        throw new Error('defaultModel was not interpolated');
      }
    });

    const config = await ctx.check(
      'YAML, env and overrides merge in priority order',
      (evidence) => {
        const loaded = withEnv(
          {
            GAUNTLET_CONFIG_MODEL: ctx.model,
            GAUNTLET_CONFIG_GREETING: 'hello from the environment',
            COGITATOR_LIMITS_MAX_CONCURRENT_RUNS: '3',
          },
          () => loadConfig({ configPath, overrides: { logging: { level: 'error' } } })
        );
        evidence('defaultModel', loaded.llm?.defaultModel);
        evidence('limits', loaded.limits);
        evidence('logging', loaded.logging);
        evidence('memory', loaded.memory?.adapter);
        evidence('deploy', loaded.deploy);
        if (loaded.llm?.defaultModel !== ctx.model) throw new Error('YAML defaultModel was lost');
        if (loaded.limits?.maxConcurrentRuns !== 3) {
          throw new Error('COGITATOR_LIMITS_MAX_CONCURRENT_RUNS did not override the YAML value');
        }
        if (loaded.limits?.defaultTimeout !== 90_000) {
          throw new Error('YAML limits.defaultTimeout was lost');
        }
        if (loaded.logging?.level !== 'error') {
          throw new Error('The code override did not win over YAML');
        }
        if (loaded.logging?.format !== 'json') throw new Error('Deep merge dropped logging.format');
        if (loaded.memory?.adapter !== 'memory') throw new Error('YAML memory.adapter was lost');
        const plugin = loaded.llm?.plugins?.[YAML_PLUGIN];
        evidence('pluginGreeting', isPluginSettings(plugin) ? plugin.greeting : plugin);
        if (!isPluginSettings(plugin) || plugin.greeting !== 'hello from the environment') {
          throw new Error(
            'loadConfig did not interpolate ${GAUNTLET_CONFIG_GREETING} from process.env'
          );
        }
        return loaded;
      }
    );

    await ctx.check('invalid YAML values are rejected with the field path', async (evidence) => {
      const invalidPath = join(ctx.tmpDir, 'invalid.yml');
      await writeFile(
        invalidPath,
        'limits:\n  maxConcurrentRuns: -4\nmemory:\n  adapter: floppy\n'
      );
      let message: string | undefined;
      try {
        loadConfig({ configPath: invalidPath, skipEnv: true });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      if (message === undefined) throw new Error('An invalid config loaded without an error');
      evidence('error', message.slice(0, 240));
      if (!message.includes('maxConcurrentRuns') || !message.includes('adapter')) {
        throw new Error('The validation error does not name both offending fields');
      }
    });

    const runtime = ctx.createCogitator({
      ...config,
      llm: { defaultModel: config.llm?.defaultModel, retry: config.llm?.retry },
    });
    ctx.log(
      'llm.backends cannot come from YAML, so the YAML runtime gets the OpenRouter backend from the gauntlet'
    );

    await ctx.check('the YAML model and memory drive a run', async (evidence) => {
      const agent = new Agent({
        name: 'yaml-agent',
        instructions: 'You are a terse assistant. Answer in one short sentence.',
        maxIterations: 1,
      });
      const threadId = `config-yaml-${Date.now()}`;
      const first = await runtime.run(agent, {
        input: 'Remember this locker code for later: 6142. Reply with OK.',
        threadId,
      });
      const second = await runtime.run(agent, {
        input: 'What was the locker code I gave you? Reply with the number only.',
        threadId,
      });
      evidence('modelUsed', second.modelUsed);
      evidence('answer', second.output.slice(0, 80));
      evidence('runtimeCostUsd', second.usage.cost);
      evidence('tokens', first.usage.totalTokens + second.usage.totalTokens);
      if (second.modelUsed && second.modelUsed !== config.llm?.defaultModel) {
        throw new Error(`The run used ${second.modelUsed}, not the YAML defaultModel`);
      }
      if (!second.output.includes('6142')) {
        throw new Error(
          'The second turn did not recall the code: YAML memory did not keep the thread'
        );
      }
    });

    await ctx.check('a backend plugin configured only in YAML serves runs', async (evidence) => {
      unregisterLLMBackend(YAML_PLUGIN);
      registerLLMBackend<PluginSettings>({
        metadata: { name: 'Gauntlet YAML plugin' },
        provider: YAML_PLUGIN,
        validateConfig: isPluginSettings,
        factory: greetingBackend,
      });
      ctx.onCleanup(() => {
        unregisterLLMBackend(YAML_PLUGIN);
      });

      const pluginConfig = withEnv({ GAUNTLET_CONFIG_MODEL: `${YAML_PLUGIN}/echo` }, () =>
        loadConfig({ configPath, skipEnv: true })
      );
      const pure = new Cogitator(pluginConfig);
      ctx.onCleanup(() => pure.close());
      const result = await pure.run(new Agent({ name: 'plugin-agent', instructions: 'Greet.' }), {
        input: 'Hello?',
      });
      evidence('output', result.output);
      if (result.output !== 'greetings from the yaml default') {
        throw new Error(`The plugin answered "${result.output}" instead of its YAML greeting`);
      }
    });
  },
};

interface PriceComparison {
  id: string;
  known: boolean;
  registryId?: string;
  registryProvider?: string;
  registryPerMillion?: { input: number; output: number };
  openRouterPerMillion?: { input: number; output: number };
}

function perMillion(model: ModelInfo | null): { input: number; output: number } | undefined {
  return model ? { input: model.pricing.input, output: model.pricing.output } : undefined;
}

/** Proves the model registry loads the live catalogue and reports what it knows about our models. */
const modelRegistry: StageDefinition = {
  id: 'model-registry',
  title: 'Model registry',
  description:
    'The model registry loads the live LiteLLM catalogue into a file cache and prices the gauntlet models like OpenRouter, and a run reports what the provider charged.',
  packages: [MODELS, CORE],
  needs: ['handshake'],
  timeoutMs: 60_000,
  async run(ctx) {
    const cachePath = join(ctx.tmpDir, 'models-cache.json');
    const cache = { ttl: 60 * 60 * 1000, storage: 'file' as const, filePath: cachePath };

    const registry = await ctx.check(
      'the live catalogue loads into a file cache',
      async (evidence) => {
        const fresh = new ModelRegistry({ cache, fallbackToBuiltin: true });
        await fresh.initialize();
        ctx.onCleanup(() => fresh.shutdown());
        evidence('models', fresh.getModelCount());
        evidence('builtin', BUILTIN_MODELS.length);
        evidence('providers', fresh.listProviders().length);
        if (fresh.getModelCount() <= BUILTIN_MODELS.length) {
          throw new Error('Only the built-in models loaded: the LiteLLM catalogue was not fetched');
        }
        if (!existsSync(cachePath)) throw new Error('The file cache was not written');
        const cached = JSON.parse(await readFile(cachePath, 'utf8')) as { models?: unknown[] };
        evidence('cachedModels', cached.models?.length);
        return fresh;
      }
    );

    await ctx.check('a second registry starts from the cache file', async (evidence) => {
      const second = new ModelRegistry({ cache, fallbackToBuiltin: false });
      const started = Date.now();
      await second.initialize();
      second.shutdown();
      evidence('ms', Date.now() - started);
      evidence('models', second.getModelCount());
      if (second.getModelCount() !== registry.getModelCount()) {
        throw new Error('The cached registry holds a different number of models');
      }
    });

    await ctx.check('filters work on the live catalogue', (evidence) => {
      const toolModels = registry.listModels({ supportsTools: true, excludeDeprecated: true });
      const cheap = registry.listModels({ maxPricePerMillion: 1, minContextWindow: 100_000 });
      evidence('toolCapable', toolModels.length);
      evidence('cheapLongContext', cheap.length);
      if (toolModels.length === 0) throw new Error('No tool-capable models in the catalogue');
      if (cheap.some((model) => model.contextWindow < 100_000)) {
        throw new Error('minContextWindow let a smaller model through');
      }
    });

    const comparisons = await ctx.check(
      'the gauntlet models in the registry and on OpenRouter',
      async (evidence) => {
        const ids = ctx.models.map((model) => model.replace(/^openrouter\//, ''));
        const catalogue = await fetchModelCatalogue(ids, ctx.signal);
        const comparisons: PriceComparison[] = ids.map((id) => {
          const model = registry.getModel(id);
          const price = catalogue.prices.get(id);
          return {
            id,
            known: model !== null,
            ...(model ? { registryId: model.id, registryProvider: model.provider } : {}),
            ...(model ? { registryPerMillion: perMillion(model) } : {}),
            ...(price
              ? { openRouterPerMillion: { input: price.input * 1e6, output: price.output * 1e6 } }
              : {}),
          };
        });
        evidence('models', comparisons);
        const unknown = comparisons.filter((entry) => !entry.known).map((entry) => entry.id);
        evidence('unknownToRegistry', unknown);
        if (unknown.length > 0) {
          ctx.log(
            `Unknown to the model registry: ${unknown.join(', ')} (runs on them report cost 0)`
          );
        }
        return comparisons;
      }
    );

    await ctx.check('the registry prices the gauntlet models like OpenRouter', (evidence) => {
      const mispriced = comparisons.flatMap((entry) => {
        const listed = entry.openRouterPerMillion;
        const qualified = registry.getModel(`openrouter/${entry.id}`);
        const price = perMillion(qualified);
        const matches =
          listed !== undefined &&
          price !== undefined &&
          Math.abs(price.input - listed.input) < 0.01 &&
          Math.abs(price.output - listed.output) < 0.01;
        return matches
          ? []
          : [
              {
                id: `openrouter/${entry.id}`,
                registry: price,
                registryProvider: qualified?.provider,
                openRouter: listed,
              },
            ];
      });
      evidence('mispriced', mispriced);
      if (mispriced.length > 0) {
        throw new Error(
          `${mispriced.map((entry) => entry.id).join(', ')} resolve to another price than OpenRouter's`
        );
      }
    });

    await ctx.check('a run reports what the provider charged', async (evidence) => {
      const id = ctx.model.replace(/^openrouter\//, '');
      const range = await fetchPriceRange(id);
      const agent = new Agent({
        name: 'priced',
        model: ctx.model,
        instructions: 'Answer in one short sentence.',
        maxIterations: 1,
      });
      const result = await ctx.cogitator.run(agent, { input: 'What is a cogitator?' });
      const { inputTokens, outputTokens, cost } = result.usage;
      const lowest = inputTokens * range.low.input + outputTokens * range.low.output;
      const highest = inputTokens * range.high.input + outputTokens * range.high.output;
      evidence('cost', cost);
      evidence('providerRange', { lowest, highest, providers: range.providers });
      evidence('tokens', { inputTokens, outputTokens });
      if (!(cost > 0)) throw new Error(`RunResult.usage.cost is ${cost}`);
      if (cost < lowest / 2 || cost > highest * 2) {
        throw new Error(
          `Reported ${cost} USD, outside what ${range.providers} providers charge for these tokens (${lowest} to ${highest} USD)`
        );
      }
    });
  },
};

export const configStages: StageDefinition[] = [configYaml, modelRegistry];
