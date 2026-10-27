import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { experimental_runPluginEvals, type PluginEvalOptions } from '@cogitator-ai/evals';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import {
  pluginEvalCommand,
  pluginEvalOptions,
  runPluginEval,
  summaryLines,
  type PluginEvalDependencies,
} from '../commands/plugin-eval.js';

const dirs: string[] = [];
let cwd: string | undefined;

afterEach(() => {
  if (cwd) process.chdir(cwd);
  cwd = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * A plugin whose skill says to greet the house way, with one case that passes only with the
 * skill and one that never passes
 */
function pluginProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'cogitator-plugin-eval-'));
  dirs.push(root);
  const files: Record<string, string> = {
    '.claude-plugin/plugin.json': '{"name":"greeter"}',
    'skills/house-greeting/SKILL.md':
      '---\nname: house-greeting\ndescription: Greet people the house way.\n---\nSay "Ahoy from the house".\n',
    'evals/greets/prompt.md': '---\nruns: 1\nallowed_tools: [Skill]\n---\nGreet Ada.\n',
    'evals/greets/graders/greeting.md': '---\ntype: regex\npattern: Ahoy from the house\n---\n',
    'evals/goodbye/prompt.md': '---\nruns: 1\nallowed_tools: [Skill]\n---\nSay goodbye.\n',
    'evals/goodbye/graders/greeting.md': '---\ntype: regex\npattern: Ahoy\n---\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function text(content: ChatRequest['messages'][number]['content']): string {
  return typeof content === 'string'
    ? content
    : content.map((part) => ('text' in part ? part.text : '')).join('');
}

/** A model that uses the skill when it can and greets the way the skill says once it read it */
function backend(cost = 0): LLMBackend {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost };
  return {
    provider: 'openai',
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const user = text(request.messages.find((m) => m.role === 'user')?.content ?? '');
      const results = request.messages.filter((m) => m.role === 'tool');
      const skill = request.tools?.some((tool) => tool.name === 'use_skill');
      if (skill && results.length === 0 && user.includes('Greet')) {
        return {
          id: 'c',
          content: '',
          toolCalls: [
            { id: 'call_1', name: 'use_skill', arguments: { skill: 'greeter:house-greeting' } },
          ],
          finishReason: 'tool_calls',
          usage,
        };
      }
      const skilled = results.some((m) => text(m.content).includes('Ahoy from the house'));
      const answer = user.includes('goodbye')
        ? 'Goodbye.'
        : skilled
          ? 'Ahoy from the house, Ada!'
          : 'Hi Ada.';
      return { id: 'a', content: answer, finishReason: 'stop', usage };
    },
    async *chatStream(): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: { content: '' }, finishReason: 'stop' };
    },
  };
}

function dependencies(
  model: LLMBackend,
  hook?: (options: PluginEvalOptions) => void
): PluginEvalDependencies {
  return {
    env: {},
    run: (options) => {
      hook?.(options);
      return experimental_runPluginEvals({
        ...options,
        llm: { backends: { mock: model }, defaultModel: 'mock/agent' },
      });
    },
  };
}

function quietConsole() {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
}

describe('cogitator plugin eval', () => {
  it('prints progress and the summary table, and exits 0 when every case passes', async () => {
    const root = pluginProject();
    const { log } = quietConsole();
    const code = await runPluginEval(
      root,
      { case: 'greets', outputDir: join(root, 'out') },
      dependencies(backend())
    );
    expect(code).toBe(0);
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toContainEqual(
      expect.stringMatching(/^CASE\s+WITH\s+W\/OUT\s+Δ\s+RUNS\s+COST\s+NOTES$/)
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/^greets\s+1\.00\s+0\.00\s+\+1\.00\s+2\s+\$0\.00/)
    );
    expect(lines).toContainEqual(`Report: ${join(root, 'out', 'report.html')}`);
    expect(lines.some((line) => line.includes('greets with 1/1'))).toBe(true);
  });

  it('prints the result document under --json and exits 1 when a case is below the threshold', async () => {
    const root = pluginProject();
    const { log } = quietConsole();
    const code = await runPluginEval(
      root,
      { json: true, ablation: 'none', outputDir: join(root, 'out') },
      dependencies(backend())
    );
    expect(code).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    const document = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      schemaVersion: number;
      aggregates: { casesPassed: number; casesTotal: number };
    };
    expect(document).toMatchObject({
      schemaVersion: 1,
      aggregates: { casesPassed: 1, casesTotal: 2 },
    });
  });

  it('writes the document to a .json path and refuses any other path', async () => {
    const root = pluginProject();
    quietConsole();
    const out = join(root, 'results.json');
    const code = await runPluginEval(
      root,
      { json: out, case: 'greets', threshold: '0.5', outputDir: join(root, 'out') },
      dependencies(backend())
    );
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toHaveProperty('outcome', 'passed');
    await expect(
      runPluginEval(root, { json: 'results.txt' }, dependencies(backend()))
    ).rejects.toThrow('--json output path must end in .json');
  });

  it('exits 2 with partial results when the cost ceiling stops the run', async () => {
    const root = pluginProject();
    const { error } = quietConsole();
    const code = await runPluginEval(
      root,
      { maxCostUsd: '0.5', outputDir: join(root, 'out') },
      dependencies(backend(1))
    );
    expect(code).toBe(2);
    expect(error.mock.calls.map((call) => String(call[0]))).toContainEqual(
      expect.stringContaining('Partial results (cost_ceiling)')
    );
  });

  it('exits 130 when interrupted, after writing what finished', async () => {
    const root = pluginProject();
    quietConsole();
    const deps = dependencies(backend());
    const code = await runPluginEval(
      root,
      { outputDir: join(root, 'out') },
      {
        ...deps,
        run: (options) =>
          deps.run({
            ...options,
            onProgress: (event) => {
              options.onProgress?.(event);
              if (event.type === 'run') process.listeners('SIGINT').at(-1)?.('SIGINT');
            },
          }),
      }
    );
    expect(code).toBe(130);
    const written = JSON.parse(
      readFileSync(join(root, 'out', 'aggregate-result.json'), 'utf8')
    ) as {
      partialReason: string;
    };
    expect(written.partialReason).toBe('interrupted');
  });

  it('exits 143 when terminated', async () => {
    const root = pluginProject();
    quietConsole();
    const deps = dependencies(backend());
    const code = await runPluginEval(
      root,
      { outputDir: join(root, 'out') },
      {
        ...deps,
        run: (options) =>
          deps.run({
            ...options,
            onProgress: (event) => {
              if (event.type === 'run') process.listeners('SIGTERM').at(-1)?.('SIGTERM');
            },
          }),
      }
    );
    expect(code).toBe(143);
  });

  it('refuses invalid option values with exit code 1 and a load error as a plugin eval error', async () => {
    const root = pluginProject();
    quietConsole();
    for (const flags of [
      { runs: '0' },
      { concurrency: '9' },
      { threshold: '1.5' },
      { ablation: 'both' },
    ]) {
      await expect(runPluginEval(root, flags, dependencies(backend()))).rejects.toMatchObject({
        exitCode: 1,
      });
    }
    await expect(
      runPluginEval(join(root, 'skills'), {}, dependencies(backend()))
    ).rejects.toMatchObject({
      name: 'CommandError',
      message: expect.stringContaining('is not a plugin directory'),
    });
  });

  it('takes the LLM configuration from the project config and COGITATOR_MODEL', () => {
    const root = pluginProject();
    writeFileSync(
      join(root, 'cogitator.yml'),
      'llm:\n  defaultProvider: openai\n  defaultModel: openai/gpt-6.1-sol\n'
    );
    cwd = process.cwd();
    process.chdir(root);
    const fromConfig = pluginEvalOptions(
      '.',
      { allowTools: ['Write'], tag: ['smoke'], case: 'g*' },
      {}
    );
    expect(fromConfig).toMatchObject({
      target: '.',
      llm: { defaultModel: 'openai/gpt-6.1-sol' },
      allowTools: ['Write'],
      tags: ['smoke'],
      caseGlob: 'g*',
    });
    expect(
      pluginEvalOptions(undefined, {}, { COGITATOR_MODEL: 'ollama/qwen3.5:9b' }).llm
    ).toMatchObject({
      defaultModel: 'ollama/qwen3.5:9b',
    });
  });

  it('shows SCORE and PASS% when no case has a baseline', async () => {
    const root = pluginProject();
    quietConsole();
    const deps = dependencies(backend());
    let lines: string[] = [];
    await runPluginEval(
      root,
      { ablation: 'none', outputDir: join(root, 'out') },
      {
        ...deps,
        run: async (options) => {
          const report = await deps.run(options);
          lines = summaryLines(report.result);
          return report;
        },
      }
    );
    expect(lines[0]).toMatch(/^CASE\s+SCORE\s+PASS%\s+RUNS\s+COST\s+NOTES$/);
    expect(lines.find((line) => line.startsWith('goodbye'))).toMatch(
      /^goodbye\s+0\.00\s+0%\s+1\s+\$0\.00\s+greeting: \/Ahoy\/ not found in last_message$/
    );
  });

  it('declares the options of claude plugin eval', () => {
    const flags = pluginEvalCommand.options.map((option) => option.long);
    expect(flags).toEqual(
      expect.arrayContaining([
        '--runs',
        '--concurrency',
        '--model',
        '--judge-model',
        '--ablation',
        '--threshold',
        '--max-cost-usd',
        '--allow-tools',
        '--scaffold',
        '--case',
        '--tag',
        '--eval-dir',
        '--json',
        '--output-dir',
        '--keep-temp',
        '--verbose',
      ])
    );
    expect(pluginEvalCommand.name()).toBe('eval');
  });
});
