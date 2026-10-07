import { code, tsString } from '../code.js';
import { providerInfo } from '../providers.js';
import { ciInstallCommand, execCommand, runScript } from '../package-manager.js';
import { runsOnBun, type ProjectSpec } from '../spec.js';
import { cogitatorVersion, VERSIONS } from '../versions.js';
import type { ProjectBuilder } from '../project.js';
import type { FeatureModule } from './types.js';
import { CALCULATOR_TS, CURRENT_TIME_TS, FETCH_URL_TS, TOOLS_TEST_TS } from './starter-tools.js';

const BIOME_SCHEMA_VERSION = VERSIONS.biome.replace(/^\^/, '');

function tsconfig(spec: ProjectSpec): string {
  const bun = runsOnBun(spec);
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: 'es2023',
          lib: ['es2024'],
          module: 'nodenext',
          moduleResolution: 'nodenext',
          types: [bun ? 'bun' : 'node'],
          strict: true,
          verbatimModuleSyntax: true,
          isolatedModules: true,
          resolveJsonModule: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['src', 'tests', 'evals', '*.config.ts'],
      },
      null,
      2
    ) + '\n'
  );
}

function tsconfigBuild(): string {
  return (
    JSON.stringify(
      {
        extends: './tsconfig.json',
        compilerOptions: { noEmit: false, rootDir: 'src', outDir: 'dist', sourceMap: true },
        include: ['src'],
      },
      null,
      2
    ) + '\n'
  );
}

function biomeJson(spec: ProjectSpec): string {
  const ignored = ['!**/dist', '!**/data', '!**/.cogitator', '!**/node_modules'];
  if (spec.app === 'next') ignored.push('!**/.next', '!**/next-env.d.ts');
  return (
    JSON.stringify(
      {
        $schema: `https://biomejs.dev/schemas/${BIOME_SCHEMA_VERSION}/schema.json`,
        files: { includes: ['**', ...ignored] },
        formatter: { enabled: true, indentStyle: 'space', indentWidth: 2, lineWidth: 100 },
        javascript: {
          formatter: { quoteStyle: 'single', semicolons: 'always', trailingCommas: 'es5' },
        },
        linter: { enabled: true, rules: { preset: 'recommended' } },
        ...(spec.app === 'next' && { css: { parser: { tailwindDirectives: true } } }),
        assist: { actions: { source: { organizeImports: 'on' } } },
      },
      null,
      2
    ) + '\n'
  );
}

const VITEST_CONFIG_TS = code`
  import { defineConfig } from 'vitest/config';

  export default defineConfig({
    test: {
      include: ['tests/**/*.test.ts'],
      testTimeout: 30_000,
    },
  });
`;

const TEST_HELPERS_TS = code`
  import { loadConfig } from '@cogitator-ai/config';
  import { createMockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
  import { createCogitator } from '../src/cogitator.js';

  /** The provider of the project's default model, the backend a mock has to stand in for. */
  function defaultProvider(): string {
    const llm = loadConfig().llm;
    return llm?.defaultModel?.split('/')[0] ?? llm?.defaultProvider ?? 'openai';
  }

  /**
   * A Cogitator whose model answers with \`responses\`, one per call, so tests run
   * offline and decide exactly what the model says. Memory stays in the process.
   */
  export function mockCogitator(...responses: MockChatResponse[]) {
    const backend = createMockLLMBackend().setResponses(responses);
    const cogitator = createCogitator({
      llm: { backends: { [defaultProvider()]: backend } },
      memory: { adapter: 'memory' },
    });
    return { backend, cogitator };
  }
`;

const ASSISTANT_TEST_TS = code`
  import { afterEach, describe, expect, it } from 'vitest';
  import type { Cogitator } from '@cogitator-ai/core';
  import { agents } from '../src/cogitator.js';
  import { mockCogitator } from './helpers.js';

  let cogitator: Cogitator | undefined;

  afterEach(async () => {
    await cogitator?.close();
    cogitator = undefined;
  });

  describe('assistant', () => {
    it('calls the calculator and answers with its result', async () => {
      const mock = mockCogitator(
        {
          toolCalls: [{ id: 'call-1', name: 'calculator', arguments: { expression: '6 * 7' } }],
          finishReason: 'tool_calls',
        },
        { content: '6 * 7 is 42.' }
      );
      cogitator = mock.cogitator;

      const result = await cogitator.run(agents.assistant, { input: 'What is 6 * 7?' });

      expect(result.output).toBe('6 * 7 is 42.');
      expect(result.toolCalls.map((call) => call.name)).toEqual(['calculator']);
      expect(JSON.stringify(mock.backend.getLastCall()?.messages)).toContain('42');
    });

    it('answers directly when no tool is needed', async () => {
      const mock = mockCogitator({ content: 'Hello!' });
      cogitator = mock.cogitator;

      const result = await cogitator.run(agents.assistant, { input: 'Hi' });

      expect(result.output).toBe('Hello!');
      expect(result.toolCalls).toEqual([]);
    });
  });
`;

function ciWorkflow(spec: ProjectSpec, packageManagerSpec: string | undefined): string {
  const pm = spec.packageManager;
  const setup =
    pm === 'bun'
      ? code`
          - uses: oven-sh/setup-bun@v2
        `
      : code`
          ${pm === 'pnpm' && '- uses: pnpm/action-setup@v6'}
          ${pm === 'yarn' && '- run: corepack enable'}
          - uses: actions/setup-node@v7
            with:
              node-version: 24
              cache: ${pm}
        `;
  const evals = spec.features.includes('evals');
  return code`
    name: CI

    on:
      push:
        branches: [main]
      pull_request:

    jobs:
      check:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v7
          ${setup}
          - run: ${ciInstallCommand(pm, packageManagerSpec)}
          - run: ${runScript(pm, 'typecheck')}
          - run: ${runScript(pm, 'lint')}
          - run: ${runScript(pm, 'test')}
          ${evals && `- run: ${runScript(pm, 'eval')}`}
          ${
            evals &&
            code`
              env:
                ${providerInfo(spec.provider).envKey ?? 'OLLAMA_BASE_URL'}: \${{ secrets.${providerInfo(spec.provider).envKey ?? 'OLLAMA_BASE_URL'} }}
            `
          }
  `;
}

function assistantAgent(project: ProjectBuilder): string {
  const lines = [
    'You are a capable, honest assistant.',
    'Use your tools when they help: fetch_url to read web pages, calculator for arithmetic, current_time for dates and times.',
    ...project.instructions,
    'When you are unsure, say so instead of guessing.',
  ];
  return code`
    import { Agent } from '@cogitator-ai/core';
    import { tools } from '../tools/index.js';

    export const assistant = new Agent({
      name: 'assistant',
      description: 'The general-purpose assistant of this project',
      instructions: [
        ${lines.map((line) => `${tsString(line)},`).join('\n')}
      ].join('\\n'),
      tools,
    });
  `;
}

export const baseFeature: FeatureModule = {
  id: 'base',
  applies: () => true,
  apply(project) {
    const { spec } = project;
    const bun = runsOnBun(spec);

    project
      .dependency('@cogitator-ai/core', cogitatorVersion('@cogitator-ai/core'))
      .dependency('@cogitator-ai/config', cogitatorVersion('@cogitator-ai/config'))
      .dependency('zod', VERSIONS.zod)
      .devDependency('@cogitator-ai/cli', cogitatorVersion('@cogitator-ai/cli'))
      .devDependency('@cogitator-ai/test-utils', cogitatorVersion('@cogitator-ai/test-utils'))
      .devDependency('@biomejs/biome', VERSIONS.biome)
      .devDependency('tsx', VERSIONS.tsx)
      .devDependency('vitest', VERSIONS.vitest);

    if (bun) {
      project.devDependency('@types/bun', VERSIONS.typesBun);
    } else {
      project.devDependency('@types/node', VERSIONS.typesNode);
    }

    if (spec.app !== 'next') {
      project
        .devDependency('typescript', VERSIONS.typescript)
        .file('tsconfig.json', tsconfig(spec))
        .file('tsconfig.build.json', tsconfigBuild());
    }

    project
      .file('src/tools/fetch-url.ts', FETCH_URL_TS)
      .file('src/tools/current-time.ts', CURRENT_TIME_TS)
      .file('src/tools/calculator.ts', CALCULATOR_TS)
      .tool('fetchUrl', './fetch-url.js')
      .tool('currentTime', './current-time.js')
      .tool('calculator', './calculator.js')
      .register({
        kind: 'agents',
        name: 'assistant',
        from: './agents/assistant.js',
        binding: 'assistant',
      })
      .file('tests/tools.test.ts', TOOLS_TEST_TS)
      .file('tests/helpers.ts', TEST_HELPERS_TS)
      .file('tests/assistant.test.ts', ASSISTANT_TEST_TS)
      .file('vitest.config.ts', VITEST_CONFIG_TS)
      .file('biome.json', biomeJson(spec))
      .file('.github/workflows/ci.yml', ciWorkflow(spec, project.packageManagerSpec))
      .script('test', 'vitest run')
      .script('typecheck', 'tsc --noEmit')
      .script('lint', 'biome check .')
      .script('format', 'biome check --write .')
      .script('doctor', 'cogitator doctor')
      .script('dev:studio', 'cogitator dev')
      .ignore('node_modules/', 'dist/', '.env', '.env.*', '!.env.example', '*.log', '*.tsbuildinfo')
      .ignore('.DS_Store', 'coverage/', '.cogitator/studio/', '.cogitator/checkpoints/');

    const info = providerInfo(spec.provider);
    if (info.envKey) {
      project.envVar({
        name: info.envKey,
        description: `${info.label} API key, from ${info.keyUrl}`,
        required: true,
        secret: true,
      });
    } else {
      project.envVar({
        name: 'OLLAMA_BASE_URL',
        description: 'Where Ollama listens',
        example: 'http://localhost:11434',
        required: false,
        secret: false,
      });
    }

    project.section(
      'Commands',
      code`
        - \`${runScript(spec.packageManager, 'dev')}\`: run with reload on change
        - \`${runScript(spec.packageManager, 'test')}\`: offline tests, the model is mocked with \`mockCogitator\` from \`tests/helpers.ts\`
        - \`${runScript(spec.packageManager, 'typecheck')}\` and \`${runScript(spec.packageManager, 'lint')}\`: run both before you call a change done
        - \`${runScript(spec.packageManager, 'dev:studio')}\`: Cogitator Studio, to chat with the agents, read traces and costs, approve tool calls, run workflows and fork runs
        - \`${runScript(spec.packageManager, 'doctor')}\`: checks keys, services and models when something does not start
        - \`${execCommand(spec.packageManager, 'cogitator add')} <feature>\`: adds rag, mcp, workflows, evals and the other generated features to this project, \`--dry-run\` shows the diff first
      `
    );
    project.readmeSection(
      'Cogitator Studio',
      code`
        \`${runScript(spec.packageManager, 'dev:studio')}\` opens a local studio for this project at http://localhost:4321: chat with every agent of \`src/cogitator.ts\` with streamed answers and tool calls, approve the calls that need it, read the trace of each run with its model calls, tool calls, nested agents, tokens and cost, run the workflows, and fork a run from any step with a changed input or tool result to compare both branches. It reloads when you save, and keeps the history in \`.cogitator/studio/\`.
      `
    );
  },
};

/** Writes `src/agents/assistant.ts` once every feature has added its instructions. */
export function emitAssistant(project: ProjectBuilder): void {
  project.file('src/agents/assistant.ts', assistantAgent(project));
}
