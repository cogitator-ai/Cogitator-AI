import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { experimental_runPluginEvals } from '@cogitator-ai/evals';
import type { ChatRequest, ChatResponse, LLMBackend } from '@cogitator-ai/types';
import { getTestModel, ollamaSkipReason } from '../../helpers/setup';

const describeOllama = describe.skipIf((await ollamaSkipReason()) !== null);

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

/** A model that greets the house way only when the plugin's skill is in its prompt */
const greeter: LLMBackend = {
  provider: 'scripted',
  chat: async (request: ChatRequest): Promise<ChatResponse> => {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content))
      .join('\n');
    const content = system.includes('house-greeting') ? 'Ahoy from the house, Ada!' : 'Hello Ada.';
    return { id: 'g', content, finishReason: 'stop', usage };
  },
  chatStream: async function* () {
    yield { id: 'g', delta: { content: '' }, finishReason: 'stop', usage };
  },
};

let base: string;
let plugin: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-plugin-evals-')));
  plugin = join(base, 'house');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'house', version: '1.0.0' })
  );
  mkdirSync(join(plugin, 'skills', 'house-greeting'), { recursive: true });
  writeFileSync(
    join(plugin, 'skills', 'house-greeting', 'SKILL.md'),
    '---\nname: house-greeting\ndescription: Greets people the house way. Use whenever asked to greet someone.\n---\nStart every greeting with "Ahoy from the house".\n'
  );
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function evalCase(
  name: string,
  prompt: string,
  graders: Record<string, string>,
  frontmatter = ''
): void {
  const dir = join(plugin, 'evals', name);
  mkdirSync(join(dir, 'graders'), { recursive: true });
  writeFileSync(join(dir, 'prompt.md'), `---\n${frontmatter}runs: 1\n---\n\n${prompt}\n`);
  for (const [grader, text] of Object.entries(graders))
    writeFileSync(join(dir, 'graders', `${grader}.md`), text);
}

describe('Evals: plugin eval suites', () => {
  it(
    'scores a case with and without the plugin and writes the result document',
    { timeout: 60_000 },
    async () => {
      evalCase('greets', 'Greet Ada for me.', {
        house: '---\ntype: regex\npattern: Ahoy from the house\n---\n',
      });
      const report = await experimental_runPluginEvals({
        target: plugin,
        llm: { backends: { scripted: greeter }, retry: false },
        model: 'scripted/m',
        ablation: 'with-without',
      });
      const [only] = report.result.cases;
      expect(report.result.schemaVersion).toBe(1);
      expect(only?.name).toBe('greets');
      expect(only?.aggregates.score).toBe(1);
      expect(only?.aggregates.delta).toBe(1);
      expect(report.result.aggregates.casesPassed).toBe(1);
      expect(existsSync(report.reportFile)).toBe(true);
      const written = JSON.parse(readFileSync(report.resultFile, 'utf8')) as {
        schemaVersion: number;
      };
      expect(written.schemaVersion).toBe(1);
    }
  );

  it('fails a case below the threshold', { timeout: 60_000 }, async () => {
    evalCase('never', 'Greet Ada for me.', {
      other: '---\ntype: regex\npattern: Good evening\n---\n',
    });
    const report = await experimental_runPluginEvals({
      target: plugin,
      llm: { backends: { scripted: greeter }, retry: false },
      model: 'scripted/m',
      ablation: 'none',
    });
    expect(report.result.cases[0]?.aggregates.score).toBe(0);
    expect(report.result.aggregates.casesPassed).toBe(0);
  });
});

describeOllama('Evals: a plugin eval suite on Ollama', () => {
  it('runs a case on a real model and grades the reply', { timeout: 180_000 }, async () => {
    evalCase(
      'answers',
      'Reply with exactly this text and nothing else: PLUGIN-EVAL-OK',
      { said: '---\ntype: regex\npattern: PLUGIN-EVAL-OK\n---\n' },
      'max_turns: 2\n'
    );
    const report = await experimental_runPluginEvals({
      target: plugin,
      llm: { defaultModel: `ollama/${getTestModel()}` },
      model: `ollama/${getTestModel()}`,
      ablation: 'none',
      threshold: 0,
    });
    const [only] = report.result.cases;
    expect(only?.arms.with).toHaveLength(1);
    expect(only?.arms.with[0]?.error ?? null).toBeNull();
    expect(report.result.partial).toBe(false);
  });
});
