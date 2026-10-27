import { afterEach, describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { ChatRequest, ChatResponse, Message, ToolCall } from '@cogitator-ai/core';
import { writeInstalledPlugins } from '@cogitator-ai/core';
import { experimental_runPluginEvals, PluginEvalError } from '../plugin-evals';
import type { PluginEvalOptions, PluginEvalProgressEvent } from '../plugin-evals';

const GREETER = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'plugin-evals',
  'greeter'
);

function textOf(message: Message | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => ('text' in part ? part.text : '')).join('');
}

function between(text: string, tag: string): string {
  const start = text.lastIndexOf(`<${tag}>`);
  const end = text.indexOf(`</${tag}>`);
  return start === -1 || end === -1 ? '' : text.slice(start, end);
}

/**
 * A model that plays the agent and the judge: it activates the house-greeting skill when it has
 * the skill tool, greets the house way only after reading the skill, writes the card with
 * `write_file`, files issues through a mocked tracker, and judges by looking for the greeting
 */
class ScriptedBackend extends MockLLMBackend {
  readonly requests: ChatRequest[] = [];

  constructor(private readonly costPerCall = 0) {
    super();
  }

  override async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    const system = textOf(request.messages.find((message) => message.role === 'system'));
    const user = textOf(request.messages.find((message) => message.role === 'user'));
    if (system.includes('You grade one run') || user.includes('You grade one run')) {
      return this.verdict(between(user, 'evidence').includes('Ahoy from the house'));
    }
    if (system.includes('You compare one run') || user.includes('You compare one run')) {
      return this.verdict(between(user, 'run').includes('Ahoy from the house'));
    }
    if (user.includes('Take your time')) await new Promise((resolve) => setTimeout(resolve, 2000));
    if (user.includes('explode')) {
      throw Object.assign(new Error('the provider is down'), { code: 'LLM_UNAVAILABLE' });
    }
    const tools = new Set((request.tools ?? []).map((tool) => tool.name));
    const results = request.messages.filter((message) => message.role === 'tool');
    if (user.includes('Keep going')) {
      return this.call('use_skill', { skill: 'greeter:house-greeting' });
    }
    if (user.includes('Read the skill notes')) {
      if (results.length === 0) return this.call('use_skill', { skill: 'demo:notes' });
      if (results.length === 1) {
        return this.call('read_skill_file', { skill: 'demo:notes', path: 'notes.md' });
      }
      return this.answer(textOf(results.at(-1)));
    }
    if (user.includes('Run the commands')) {
      const commands = ['echo hi', 'touch stray.txt'];
      const next = commands[results.length];
      return next === undefined
        ? this.answer(results.map((message) => textOf(message)).join('\n'))
        : this.call('run_command', { command: next });
    }
    if (user.includes('File an')) {
      const issue = [...tools].find((name) => name.endsWith('__create_issue'));
      if (!issue) return this.answer('I cannot file issues here.');
      const last = results.at(-1);
      if (!last) {
        return this.call(issue, {
          title: 'Greeting broken',
          priority: user.includes('urgent') ? 'urgent' : 'high',
        });
      }
      return this.answer(textOf(last));
    }
    const skilled = results.some((message) => textOf(message).includes('Ahoy from the house'));
    if (tools.has('use_skill') && results.length === 0) {
      return this.call('use_skill', { skill: 'greeter:house-greeting' });
    }
    const greeting = skilled ? 'Ahoy from the house, Ada!' : 'Hello Ada!';
    if (user.includes('card.txt')) {
      const wrote = results.some((message) => message.name === 'write_file');
      if (tools.has('write_file') && !wrote) {
        return this.call('write_file', { path: 'card.txt', content: greeting });
      }
      return this.answer(wrote ? 'The card is written.' : 'I cannot write files here.');
    }
    if (user.includes('goodbye')) return this.answer('Goodbye, Ada.');
    return this.answer(greeting);
  }

  private usage() {
    return { inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: this.costPerCall };
  }

  private verdict(pass: boolean): ChatResponse {
    return this.answer(
      JSON.stringify({
        score: pass ? 1 : 0,
        reasoning: pass ? 'greets the house way' : 'no house greeting',
      })
    );
  }

  private answer(content: string): ChatResponse {
    return { id: 'answer', content, finishReason: 'stop', usage: this.usage() };
  }

  private call(name: string, args: Record<string, unknown>): ChatResponse {
    const toolCall: ToolCall = { id: `call_${this.requests.length}`, name, arguments: args };
    return {
      id: 'call',
      content: '',
      toolCalls: [toolCall],
      finishReason: 'tool_calls',
      usage: this.usage(),
    };
  }
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-evals-test-'));
  dirs.push(dir);
  return dir;
}

function options(
  backend: ScriptedBackend,
  extra: Partial<PluginEvalOptions> = {}
): PluginEvalOptions {
  return {
    target: GREETER,
    llm: { backends: { mock: backend }, defaultModel: 'mock/agent' },
    outputDir: tempDir(),
    ...extra,
  };
}

describe('experimental_runPluginEvals', () => {
  it('scores what the plugin adds over the no-plugin baseline', async () => {
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(options(backend, { caseGlob: 'greets' }));

    expect(result.cases.map((c) => c.name)).toEqual(['greets']);
    const [greets] = result.cases;
    expect(greets?.aggregates).toMatchObject({ score: 1, withoutScore: 0, delta: 1, passed: true });
    expect(greets?.arms.with).toHaveLength(2);
    expect(greets?.arms.without).toHaveLength(2);
    const run = greets?.arms.with[0];
    expect(run?.toolCalls[0]).toMatchObject({
      name: 'Skill',
      tool: 'use_skill',
      input: { skill: 'greeter:house-greeting' },
    });
    expect(run?.graders.find((g) => g.name === 'skill-fired')).toMatchObject({
      passed: true,
      scored: false,
    });
    const judged = run?.graders.find((g) => g.name === 'judged');
    expect(judged).toMatchObject({ passed: true, scored: true, weight: 2 });
    expect(judged?.votes).toHaveLength(3);
    expect(result.cases[0]?.arms.without[0]?.graders.map((g) => g.name)).toEqual([
      'greeting',
      'judged',
    ]);
    expect(result.outcome).toBe('passed');
    expect(result.aggregates).toMatchObject({ overallScore: 1, casesPassed: 1, meanDelta: 1 });
  });

  it('applies every grader type, with tools granted for the run and mocked MCP tools', async () => {
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(
      options(backend, { tags: ['files', 'mock'], caseGlob: '{card,issue}', allowTools: ['Write'] })
    );
    const card = result.cases.find((c) => c.name === 'card');
    const issue = result.cases.find((c) => c.name === 'issue');

    const withCard = card?.arms.with[0];
    expect(withCard?.filesCreated).toEqual(['card.txt']);
    expect(Object.fromEntries(withCard?.graders.map((g) => [g.name, g.passed]) ?? [])).toEqual({
      'card-written': true,
      'card-text': true,
      'skill-then-write': true,
      'one-write': true,
      'no-bash': true,
    });
    const withoutCard = card?.arms.without[0];
    expect(Object.fromEntries(withoutCard?.graders.map((g) => [g.name, g.passed]) ?? [])).toEqual({
      'card-written': true,
      'card-text': false,
      'skill-then-write': false,
      'one-write': true,
      'no-bash': true,
    });
    expect(card?.aggregates).toMatchObject({ score: 1, withoutScore: 0.6, passed: true });
    expect(card?.notices).not.toContainEqual(expect.stringContaining('not granted'));

    expect(issue?.notices).toContain('mocked: plugin_greeter_tracker[create_issue]');
    const withIssue = issue?.arms.with[0];
    expect(withIssue?.toolCalls[0]?.name).toBe('mcp__plugin_greeter_tracker__create_issue');
    expect(withIssue?.mockCalls[0]).toMatchObject({
      server: 'tracker',
      tool: 'create_issue',
      input: { title: 'Greeting broken', priority: 'high' },
      output: 'Filed issue #4821: Greeting broken (triaged as high\n)',
      error: false,
    });
    expect(withIssue?.graders.find((g) => g.name === 'called-tracker')).toMatchObject({
      passed: true,
      scored: false,
    });
    expect(issue?.aggregates).toMatchObject({ score: 1, withoutScore: 0, delta: 1 });
    const mockSchema = backend.requests
      .flatMap((request) => request.tools ?? [])
      .find((tool) => tool.name === 'mcp__plugin_greeter_tracker__create_issue');
    expect(mockSchema?.parameters.properties).toHaveProperty('priority');
  });

  it('judges a run against a reference transcript', async () => {
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(
      options(backend, { caseGlob: 'baseline-compare' })
    );
    const [compare] = result.cases;
    const grader = compare?.arms.with[0]?.graders[0];
    expect(grader).toMatchObject({ name: 'compare', type: 'baseline', passed: true });
    expect(grader?.explanation).toMatch(/^3 of 3 votes PASS/);
    expect(compare?.arms.without[0]?.graders[0]?.passed).toBe(false);
  });

  it('gives a case only the read-only tools it lists unless the run grants more', async () => {
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(
      options(backend, { caseGlob: 'card', ablation: 'none' })
    );
    const [card] = result.cases;
    expect(card?.notices).toContain('not granted: Write');
    const offered = new Set(backend.requests.flatMap((r) => (r.tools ?? []).map((t) => t.name)));
    expect(offered.has('write_file')).toBe(false);
    expect(offered.has('use_skill')).toBe(true);
    expect(card?.arms.with[0]?.filesCreated).toEqual([]);
    expect(card?.aggregates.passed).toBe(false);
  });

  it('aborts a run whose mocked call breaks the expect guard', async () => {
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(
      options(backend, { caseGlob: 'bad-issue', ablation: 'none' })
    );
    const run = result.cases[0]?.arms.with[0];
    expect(run?.aborted).toEqual({
      server: 'tracker',
      tool: 'create_issue',
      reason: 'expect: priority is not one of "low", "medium", "high"',
    });
    expect(run?.error).toBeNull();
    expect(run?.score).toBe(0);
  });

  it('fails a case below the threshold and passes it at a lower one', async () => {
    const backend = new ScriptedBackend();
    const strict = await experimental_runPluginEvals(
      options(backend, { tags: ['failing'], ablation: 'none' })
    );
    expect(strict.result.cases[0]?.aggregates).toMatchObject({ score: 0, passed: false });
    expect(strict.result.outcome).toBe('failed');

    const lenient = await experimental_runPluginEvals(
      options(backend, { tags: ['failing'], ablation: 'none', threshold: 0 })
    );
    expect(lenient.result.outcome).toBe('passed');
  });

  it('stops starting runs once the cost ceiling is spent and reports a partial result', async () => {
    const backend = new ScriptedBackend(1);
    const events: PluginEvalProgressEvent[] = [];
    const { result } = await experimental_runPluginEvals(
      options(backend, { caseGlob: 'greets', maxCostUsd: 0.5, onProgress: (e) => events.push(e) })
    );
    expect(result).toMatchObject({
      partial: true,
      partialReason: 'cost_ceiling',
      outcome: 'partial',
    });
    const [greets] = result.cases;
    expect(greets?.arms.with).toHaveLength(1);
    expect(greets?.arms.without).toHaveLength(0);
    expect(greets?.arms.with[0]?.skippedPaidGraders).toBe(true);
    expect(greets?.arms.with[0]?.graders.find((g) => g.name === 'judged')).toMatchObject({
      skipped: true,
      scored: false,
    });
    expect(result.costUsd).toBe(2);
    expect(events.filter((e) => e.type === 'skipped')).toHaveLength(3);
  });

  it('filters cases by name glob, by tag and by a single case file', async () => {
    const backend = new ScriptedBackend();
    const byGlob = await experimental_runPluginEvals(
      options(backend, { caseGlob: '*issue', ablation: 'none' })
    );
    expect(byGlob.result.cases.map((c) => c.name)).toEqual(['bad-issue', 'issue']);

    const byTag = await experimental_runPluginEvals(
      options(backend, { tags: ['smoke', 'failing'], ablation: 'none', runs: 1 })
    );
    expect(byTag.result.cases.map((c) => c.name)).toEqual(['greets', 'never-greets']);

    const byFile = await experimental_runPluginEvals(
      options(backend, { target: join(GREETER, 'evals', 'greets', 'prompt.md'), runs: 1 })
    );
    expect(byFile.result.cases.map((c) => c.name)).toEqual(['greets']);

    await expect(
      experimental_runPluginEvals(options(backend, { caseGlob: 'nothing-*' }))
    ).rejects.toThrow(PluginEvalError);
  });

  it('scores every grader in a single-arm run', async () => {
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(
      options(backend, { caseGlob: 'greets', ablation: 'none', runs: 1 })
    );
    const [greets] = result.cases;
    expect(greets?.singleArm).toBe(true);
    expect(greets?.arms.without).toEqual([]);
    expect(greets?.aggregates.delta).toBeUndefined();
    expect(greets?.arms.with[0]?.graders.every((g) => g.scored)).toBe(true);
  });

  it('writes aggregate-result.json and a self-contained report.html under evals/results', async () => {
    const root = join(tempDir(), 'greeter');
    cpSync(GREETER, root, { recursive: true });
    const backend = new ScriptedBackend();
    const { result, resultFile, reportFile, outputDir } = await experimental_runPluginEvals({
      target: root,
      llm: { backends: { mock: backend }, defaultModel: 'mock/agent' },
      caseGlob: 'greets',
      runs: 1,
    });
    expect(dirname(outputDir)).toBe(join(root, 'evals', 'results'));
    expect(readdirSync(outputDir).sort()).toEqual(['aggregate-result.json', 'report.html']);
    const json = JSON.parse(readFileSync(resultFile, 'utf8')) as Record<string, unknown>;
    expect(json).toMatchObject({
      schemaVersion: 1,
      partial: false,
      partialReason: null,
      plugin: { name: 'greeter', version: '1.0.0' },
      aggregates: { overallScore: 1, casesPassed: 1, casesTotal: 1, meanDelta: 1 },
    });
    expect(typeof json.cogitatorVersion).toBe('string');
    expect(json).toHaveProperty('cases.0.arms.with.0.graders.0.explanation');
    expect(result.durationSeconds).toBeGreaterThan(0);
    const html = readFileSync(reportFile, 'utf8');
    expect(html).toContain('Plugin effect');
    expect(html).toContain('plugin-fired indicator');
    expect(html).not.toMatch(/<script|src=|href="http/);
  });
});

/** A plugin in a temporary directory, from file contents by path */
function plugin(files: Record<string, string>): string {
  const root = join(tempDir(), 'demo');
  const all: Record<string, string> = {
    '.claude-plugin/plugin.json': '{"name":"demo"}',
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const GRADER = '---\ntype: regex\npattern: Hello\n---\n';

describe('experimental_runPluginEvals suites', () => {
  it('reports cases that fail to load and runs the rest', async () => {
    const root = plugin({
      'evals/bad-key/prompt.md': '---\ncolour: red\n---\nGreet Ada.\n',
      'evals/bad-key/graders/hello.md': GRADER,
      'evals/bad-env/prompt.md': '---\nenv:\n  HOME: /tmp\n---\nGreet Ada.\n',
      'evals/bad-env/graders/hello.md': GRADER,
      'evals/no-graders/prompt.md': 'Greet Ada.\n',
      'evals/bad-regex/prompt.md': 'Greet Ada.\n',
      'evals/bad-regex/graders/hello.md': '---\ntype: regex\npattern: (?i)hello\n---\n',
      'evals/group/ok/prompt.md': '---\nruns: 1\n---\nGreet Ada.\n',
      'evals/group/ok/graders/hello.md': GRADER,
    });
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(
      options(backend, { target: root, ablation: 'none' })
    );
    const errors = Object.fromEntries(result.cases.map((c) => [c.path, c.error]));
    expect(errors['bad-key']).toMatch(/invalid prompt.md frontmatter: .*colour/);
    expect(errors['bad-env']).toMatch(/EVAL_\[A-Z0-9_\]\*/);
    expect(errors['no-graders']).toMatch(/invalid case.yaml: graders/);
    expect(errors['bad-regex']).toMatch(/flags: i/);
    expect(errors['group/ok']).toBeUndefined();
    expect(result.cases.find((c) => c.path === 'group/ok')?.aggregates.passed).toBe(true);
    expect(result).toMatchObject({ loadErrors: 4, outcome: 'failed' });
  });

  it('reads the eval directory from the flag or the manifest, refusing paths that leave the plugin', async () => {
    const backend = new ScriptedBackend();
    const case_ = {
      'qa/hello/prompt.md': '---\nruns: 1\n---\nGreet Ada.\n',
      'qa/hello/graders/hello.md': GRADER,
    };
    const fromManifest = plugin({
      '.claude-plugin/plugin.json': '{"name":"demo","experimental":{"evals":"qa"}}',
      ...case_,
    });
    const run = await experimental_runPluginEvals(
      options(backend, { target: fromManifest, ablation: 'none' })
    );
    expect(run.result.evalDir).toBe(join(fromManifest, 'qa'));

    const badManifest = plugin({
      '.claude-plugin/plugin.json': '{"name":"demo","experimental":{"evals":"../qa"}}',
      'evals/hello/prompt.md': '---\nruns: 1\n---\nGreet Ada.\n',
      'evals/hello/graders/hello.md': GRADER,
    });
    const warned = await experimental_runPluginEvals(
      options(backend, { target: badManifest, ablation: 'none' })
    );
    expect(warned.result.warnings[0]).toMatch(/^Warning: experimental.evals "..\/qa"/);
    expect(warned.result.evalDir).toBe(join(badManifest, 'evals'));

    await expect(
      experimental_runPluginEvals(options(backend, { target: fromManifest, evalDir: '../qa' }))
    ).rejects.toThrow('--eval-dir ../qa contains ..');
    await expect(
      experimental_runPluginEvals(options(backend, { target: fromManifest, evalDir: '/abs' }))
    ).rejects.toThrow('is absolute');
  });

  it('records a run that hits max_turns as a run error and still grades it', async () => {
    const root = plugin({
      'skills/house-greeting/SKILL.md':
        '---\nname: house-greeting\ndescription: Greets.\n---\nSay Ahoy from the house.\n',
      'evals/loop/prompt.md':
        '---\nruns: 1\nmax_turns: 2\nallowed_tools: [Skill]\n---\nKeep going.\n',
      'evals/loop/graders/skill.md': '---\ntype: tool_used\ntool: Skill\n---\n',
    });
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(
      options(backend, { target: root, ablation: 'none' })
    );
    const run = result.cases[0]?.arms.with[0];
    expect(run?.error).toBe('reached max_turns (2)');
    expect(run?.graders[0]?.passed).toBe(true);
  });

  it('scores a run that ended on a provider error 0 without grading and fails the command', async () => {
    const root = plugin({
      'evals/boom/prompt.md': '---\nruns: 1\n---\nPlease explode.\n',
      'evals/boom/graders/hello.md': '---\ntype: regex\npattern: Hello\nmatch: not_contains\n---\n',
    });
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(
      options(backend, { target: root, ablation: 'none', threshold: 0 })
    );
    const run = result.cases[0]?.arms.with[0];
    expect(run).toMatchObject({ apiError: true, score: 0, graders: [] });
    expect(run?.error).toMatch(/^API error: .*the provider is down/);
    expect(result).toMatchObject({ apiErrors: 1, outcome: 'failed' });
  });

  it('resumes a transcript in a single arm and runs the scaffold only when asked', async () => {
    const root = plugin({
      'evals/resume/prompt.md': '---\nruns: 1\n---\nGreet Ada again.\n',
      'evals/resume/case.yaml': [
        'schema_version: "1.1"',
        'name: resume',
        'context:',
        '  history_file: history.jsonl',
        '  scaffold_script: setup.sh',
        '  add_dirs: [docs]',
        'graders:',
        '  - name: seeded',
        '    type: regex',
        '    pattern: seeded',
        '    target: { source: file, path: seed.txt }',
        '  - name: nothing-new',
        '    type: file_exists',
        '    path: "**"',
        '    exists: false',
        '',
      ].join('\n'),
      'evals/resume/history.jsonl': [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'My friend is Ada.' } }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] },
        }),
        '',
      ].join('\n'),
      'evals/resume/setup.sh': 'printf seeded > seed.txt\n',
      'evals/resume/docs/guide.md': '# Guide\n',
    });
    const backend = new ScriptedBackend();
    const skipped = await experimental_runPluginEvals(options(backend, { target: root }));
    const [resume] = skipped.result.cases;
    expect(resume?.singleArm).toBe(true);
    expect(resume?.notices).toEqual([
      'single-arm (no delta): the case resumes a transcript',
      'scaffold_script not run: pass --scaffold to run it',
    ]);
    expect(resume?.arms.with[0]?.graders[0]?.passed).toBe(false);
    const sent = backend.requests[0]?.messages.map((m) => textOf(m)) ?? [];
    expect(sent).toContain('My friend is Ada.');
    expect(sent).toContain('Noted.');

    const scaffolded = await experimental_runPluginEvals(
      options(backend, { target: root, scaffold: true, keepTemp: true })
    );
    const run = scaffolded.result.cases[0]?.arms.with[0];
    expect(run?.graders.map((g) => g.passed)).toEqual([true, true]);
    expect(run?.tempDir).toBeDefined();
    expect(existsSync(join(run?.tempDir ?? '', 'workspace', 'docs', 'guide.md'))).toBe(true);
    dirs.push(run?.tempDir ?? '');
  });

  it('ends a run at its timeout and grades what it produced', async () => {
    const root = plugin({
      'evals/slow/prompt.md': '---\nruns: 1\ntimeout_seconds: 0.2\n---\nTake your time.\n',
      'evals/slow/graders/hello.md': '---\ntype: regex\npattern: Hello\nmatch: not_contains\n---\n',
    });
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(
      options(backend, { target: root, ablation: 'none' })
    );
    const run = result.cases[0]?.arms.with[0];
    expect(run?.error).toBe('timed out after 0.2s');
    expect(run?.graders[0]?.passed).toBe(true);
    expect(run?.score).toBe(1);
  });

  it('stops on an interrupt and reports the runs that finished', async () => {
    const controller = new AbortController();
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(
      options(backend, {
        caseGlob: 'greets',
        signal: controller.signal,
        onProgress: (event) => {
          if (event.type === 'run') controller.abort();
        },
      })
    );
    expect(result).toMatchObject({
      partial: true,
      partialReason: 'interrupted',
      outcome: 'interrupted',
    });
    expect(result.cases[0]?.arms.with).toHaveLength(1);
  });

  it('lets a scoped grant run only the calls its rule allows', async () => {
    const root = plugin({
      'evals/shell/prompt.md':
        '---\nruns: 1\nallowed_tools: [Agent, TodoWrite]\n---\nRun the commands.\n',
      'evals/shell/graders/echoed.md':
        '---\ntype: tool_used\ntool: Bash\ninput_match: echo hi\nmin: 1\nmax: 1\n---\n',
      'evals/shell/graders/no-stray.md':
        '---\ntype: file_exists\npath: stray.txt\nexists: false\n---\n',
    });
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(
      options(backend, { target: root, ablation: 'none', allowTools: ['Bash(echo *)'] })
    );
    const run = result.cases[0]?.arms.with[0];
    expect(run?.toolCalls.map((call) => call.input)).toEqual([{ command: 'echo hi' }]);
    expect(run?.graders.map((g) => g.passed)).toEqual([true, true]);
    expect(run?.lastMessage).toMatch(/outside what the eval run grants: Bash\(echo \*\)/);
    const offered = new Set(backend.requests.flatMap((r) => (r.tools ?? []).map((t) => t.name)));
    expect([...offered].sort()).toEqual(['agent', 'run_command', 'write_todos']);
  });

  it('evaluates an installed plugin by name and writes results under the working directory', async () => {
    const pluginsRoot = tempDir();
    const cwd = tempDir();
    const now = new Date().toISOString();
    await writeInstalledPlugins(pluginsRoot, [
      {
        id: 'greeter@local',
        name: 'greeter',
        marketplace: 'local',
        version: '1.0.0',
        installPath: GREETER,
        source: { source: 'path', path: GREETER },
        pin: {},
        installedAt: now,
        lastUpdated: now,
      },
    ]);
    const backend = new ScriptedBackend();
    const { result, outputDir } = await experimental_runPluginEvals({
      target: 'greeter@local',
      cwd,
      pluginsRoot,
      llm: { backends: { mock: backend }, defaultModel: 'mock/agent' },
      caseGlob: 'greets',
      runs: 1,
      ablation: 'none',
    });
    expect(result.plugin.name).toBe('greeter');
    expect(dirname(outputDir)).toBe(join(cwd, 'evals', 'results'));
    await expect(
      experimental_runPluginEvals(options(backend, { target: 'missing', pluginsRoot }))
    ).rejects.toThrow('no installed plugin is named missing');
  });

  it('judges each case with its own agent model when no judge model is given', async () => {
    const root = plugin({
      'evals/own-model/prompt.md': '---\nruns: 1\nmodel: mock/case-model\n---\nGreet Ada.\n',
      'evals/own-model/graders/judged.md': '---\ntype: llm\n---\nPASS if it greets Ada.\n',
    });
    const judgedWith = (backend: ScriptedBackend) =>
      backend.requests
        .filter((request) =>
          textOf(request.messages.find((m) => m.role === 'user')).includes('You grade one run')
        )
        .map((request) => request.model);

    const onlyCase = new ScriptedBackend();
    const run = await experimental_runPluginEvals({
      target: root,
      llm: { backends: { mock: onlyCase } },
      ablation: 'none',
      outputDir: tempDir(),
    });
    expect(run.result.cases[0]?.error).toBeUndefined();
    expect(judgedWith(onlyCase)).toEqual(['case-model', 'case-model', 'case-model']);

    const withDefault = new ScriptedBackend();
    await experimental_runPluginEvals(options(withDefault, { target: root, ablation: 'none' }));
    expect(new Set(judgedWith(withDefault))).toEqual(new Set(['case-model']));

    const explicit = new ScriptedBackend();
    await experimental_runPluginEvals(
      options(explicit, { target: root, ablation: 'none', judgeModel: 'mock/judge' })
    );
    expect(new Set(judgedWith(explicit))).toEqual(new Set(['judge']));
  });

  it('accepts eval directories written with ./ and a list of them in plugin.json', async () => {
    const backend = new ScriptedBackend();
    const hello = (dir: string) => ({
      [`${dir}/hello/prompt.md`]: '---\nruns: 1\n---\nGreet Ada.\n',
      [`${dir}/hello/graders/hello.md`]: GRADER,
    });
    const dotted = plugin({
      '.claude-plugin/plugin.json': '{"name":"demo","experimental":{"evals":"./quality/evals"}}',
      ...hello('quality/evals'),
    });
    const first = await experimental_runPluginEvals(
      options(backend, { target: dotted, ablation: 'none' })
    );
    expect(first.result.evalDir).toBe(join(dotted, 'quality', 'evals'));
    expect(first.result.warnings).toEqual([]);

    const listed = plugin({
      '.claude-plugin/plugin.json': '{"name":"demo","experimental":{"evals":["./qa","other"]}}',
      ...hello('qa'),
    });
    const second = await experimental_runPluginEvals(
      options(backend, { target: listed, ablation: 'none' })
    );
    expect(second.result.evalDir).toBe(join(listed, 'qa'));

    const flagged = await experimental_runPluginEvals(
      options(backend, { target: listed, ablation: 'none', evalDir: './qa' })
    );
    expect(flagged.result.evalDir).toBe(join(listed, 'qa'));
    await expect(
      experimental_runPluginEvals(options(backend, { target: listed, evalDir: './qa/../..' }))
    ).rejects.toThrow('contains ..');
  });

  it('fails only the cases whose plugin declares a suite mock server that cannot be used', async () => {
    const root = plugin({
      '.mcp.json': '{"mcpServers":{"tracker":{"command":"tracker-mcp"}}}',
      'vendor/plain/.claude-plugin/plugin.json': '{"name":"plain"}',
      'evals/mocks/tracker/ask.md': '---\ntype: agent\n---\nAnswer as the tracker.\n',
      'evals/mocks/elsewhere/_server.md': '---\ntools: [a]\n---\nAnswer.\n',
      'evals/uses-tracker/prompt.md': '---\nruns: 1\n---\nGreet Ada.\n',
      'evals/uses-tracker/graders/hello.md': GRADER,
      'evals/plain/prompt.md': '---\nruns: 1\nplugins: ["../../vendor/plain"]\n---\nGreet Ada.\n',
      'evals/plain/graders/hello.md': GRADER,
    });
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(
      options(backend, { target: root, ablation: 'none' })
    );
    const byName = Object.fromEntries(result.cases.map((c) => [c.name, c]));
    expect(byName['uses-tracker']?.error).toMatch(
      /^invalid mock: .*ask\.md: type: agent mocks are not supported/
    );
    expect(byName.plain?.error).toBeUndefined();
    expect(byName.plain?.aggregates.passed).toBe(true);
    expect(byName.plain?.notices).toContainEqual(
      expect.stringMatching(
        /^mocks\/elsewhere left out: .*_server\.md agent mocks are not supported/
      )
    );
    expect(result).toMatchObject({ loadErrors: 1, outcome: 'failed' });
  });

  it('counts a case that fails to load under --tag unless its tags are known not to match', async () => {
    const root = plugin({
      'evals/broken-smoke/prompt.md': '---\ntags: [smoke]\ncolour: red\n---\nGreet Ada.\n',
      'evals/broken-smoke/graders/hello.md': GRADER,
      'evals/unreadable/prompt.md': '---\ntags: [smoke\n---\nGreet Ada.\n',
      'evals/broken-other/prompt.md': '---\ntags: [other]\ncolour: red\n---\nGreet Ada.\n',
      'evals/broken-untagged/prompt.md': '---\ncolour: red\n---\nGreet Ada.\n',
      'evals/fine/prompt.md': '---\ntags: [smoke]\nruns: 1\n---\nGreet Ada.\n',
      'evals/fine/graders/hello.md': GRADER,
    });
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(
      options(backend, { target: root, ablation: 'none', tags: ['smoke'] })
    );
    expect(result.cases.map((c) => c.name).sort()).toEqual(['broken-smoke', 'fine', 'unreadable']);
    expect(result).toMatchObject({ loadErrors: 2, outcome: 'failed' });
  });

  it('counts only use_skill calls as Skill, not read_skill_file', async () => {
    const root = plugin({
      'skills/notes/SKILL.md': '---\nname: notes\ndescription: Notes.\n---\nRead notes.md.\n',
      'skills/notes/notes.md': 'Ahoy from the notes\n',
      'evals/notes/prompt.md': '---\nruns: 1\nallowed_tools: [Skill]\n---\nRead the skill notes.\n',
      'evals/notes/graders/one-skill.md':
        '---\ntype: tool_used\ntool: Skill\nmin: 1\nmax: 1\n---\n',
      'evals/notes/graders/read-file.md': '---\ntype: tool_used\ntool: read_skill_file\n---\n',
      'evals/notes/graders/order.md':
        '---\ntype: tool_order\nbefore: Skill\nafter: read_skill_file\n---\n',
    });
    const backend = new ScriptedBackend();
    const { result } = await experimental_runPluginEvals(
      options(backend, { target: root, ablation: 'none' })
    );
    const run = result.cases[0]?.arms.with[0];
    expect(run?.toolCalls.map((call) => call.name)).toEqual(['Skill', 'read_skill_file']);
    expect(run?.graders.map((g) => [g.name, g.passed])).toEqual([
      ['one-skill', true],
      ['order', true],
      ['read-file', true],
    ]);
  });
});
