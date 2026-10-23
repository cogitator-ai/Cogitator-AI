import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { Message, ToolCall } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { defineSkill } from '../skill';
import { SkillRegistry } from '../skills/skill-registry';
import { availableSkillsSection, MAX_SKILL_CATALOG_CHARS } from '../skills/skill-tools';
import { keepThroughCompaction, RunHarness } from '../cogitator/harness';
import { ContextManager } from '../context/index';
import { compactionMiddleware } from '../middleware/builtins';
import { countMessagesTokens } from '../context/strategies/token-utils';
import { PINNED_TOOL_OUTPUTS } from '../middleware/clear-tool-outputs';
import { ToolRegistry } from '../registry';
import { CogitatorError, type RunMiddlewareContext, type SkillLoader } from '@cogitator-ai/types';
import { LocalWorkspace } from '../workspace/local-workspace';
import { workspaceTools } from '../tools/workspace-tools';
import { clearToolOutputsMiddleware } from '../middleware/clear-tool-outputs';

let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'skills-runtime-')));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function addSkill(root: string, name: string, description: string, body: string): string {
  const folder = join(root, name);
  write(
    join(folder, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`
  );
  return folder;
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

function cogitatorWith(backend: MockLLMBackend): Cogitator {
  return new Cogitator({ llm: { backends: { mock: backend }, retry: false } });
}

function toolTexts(messages: readonly Message[]): string[] {
  return messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
}

describe('SKILL.md skills in a run', () => {
  it('lists the skills in the system prompt and sends use_skill with their names', async () => {
    const root = join(base, 'skills');
    addSkill(root, 'pdf-processing', 'Extract text from PDFs. Use for PDF files.', 'Steps.');
    addSkill(root, 'code-review', 'Review code <diffs> & patches.', 'Review.');
    const backend = new MockLLMBackend().setResponse({ content: 'Hi.' });
    const cog = cogitatorWith(backend);
    const agent = new Agent({
      name: 'helper',
      model: 'mock/scripted',
      instructions: 'You help.',
      skills: [new SkillRegistry({ dirs: [root] })],
    });

    await cog.run(agent, { input: 'hello' });

    const request = backend.getLastCall()!;
    const system = String(request.messages[0]?.content);
    expect(system.startsWith('You help.\n\n<available_skills>')).toBe(true);
    expect(system).toContain(
      '<skill name="code-review">Review code &lt;diffs&gt; &amp; patches.</skill>'
    );
    expect(system).toContain('call use_skill with that skill');
    const useSkill = request.tools?.find((t) => t.name === 'use_skill');
    expect(useSkill?.parameters.properties.skill).toMatchObject({
      enum: ['code-review', 'pdf-processing'],
    });
    expect(request.tools?.some((t) => t.name === 'read_skill_file')).toBe(true);
    await cog.close();
  });

  it('adds no skill tools and no section without skills, and takes a loader config', async () => {
    const backend = new MockLLMBackend().setResponse({ content: 'Hi.' });
    const cog = cogitatorWith(backend);
    await cog.run(
      new Agent({
        name: 'plain',
        model: 'mock/scripted',
        instructions: 'Plain.',
        skills: [{ dirs: [join(base, 'nothing-here')] }],
      }),
      { input: 'hello' }
    );
    const request = backend.getLastCall()!;
    expect(request.messages[0]?.content).toBe('Plain.');
    expect(request.tools ?? []).toEqual([]);
    await cog.close();
  });

  it('returns the body, folder and files once, then a short note on a repeat', async () => {
    const root = join(base, 'skills');
    const folder = addSkill(root, 'pdf', 'PDFs.', 'Run scripts/extract.py on the file.');
    write(join(folder, 'scripts/extract.py'), 'print("text")');
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('c1', 'use_skill', { skill: 'pdf' })] },
      { toolCalls: [call('c2', 'read_skill_file', { skill: 'pdf', path: 'scripts/extract.py' })] },
      { toolCalls: [call('c3', 'use_skill', { skill: 'pdf' })] },
      { toolCalls: [call('c4', 'read_skill_file', { skill: 'pdf', path: '../../escape.txt' })] },
      { content: 'Done.' },
    ]);
    const cog = cogitatorWith(backend);
    const result = await cog.run(
      new Agent({
        name: 'reader',
        model: 'mock/scripted',
        instructions: 'Read PDFs.',
        skills: [new SkillRegistry({ dirs: [root] })],
      }),
      { input: 'Extract it' }
    );

    const [activated, script, repeat, escape] = toolTexts(result.messages);
    expect(activated).toContain(
      `<skill_content name="pdf" source="host" location="${folder}">\nRun scripts/extract.py on the file.\n</skill_content>`
    );
    expect(activated).not.toContain('description: PDFs.');
    expect(activated).toContain(`Skill folder: ${folder}`);
    expect(activated).toContain('- scripts/extract.py');
    expect(activated).toContain('read_skill_file');
    expect(script).toBe('print("text")');
    expect(repeat).toBe(
      'The skill "pdf" is already active: its instructions are earlier in this conversation. Follow them.'
    );
    expect(escape).toContain('outside the folder');
    await cog.close();
  });

  it('points to read_file for a skill in the workspace the run reads', async () => {
    const workspace = new LocalWorkspace({ root: join(base, 'project') });
    const folder = addSkill(join(workspace.root, '.agents/skills'), 'deploy', 'Deploys.', 'Go.');
    write(join(folder, 'deploy.sh'), 'echo deploy');
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('c1', 'use_skill', { skill: 'deploy' })] },
      { toolCalls: [call('c2', 'read_file', { path: '.agents/skills/deploy/deploy.sh' })] },
      { content: 'Deployed.' },
    ]);
    const cog = cogitatorWith(backend);
    const result = await cog.run(
      new Agent({
        name: 'ops',
        model: 'mock/scripted',
        instructions: 'Ops.',
        tools: workspaceTools(),
        workspace,
        skills: [new SkillRegistry()],
      }),
      { input: 'Deploy' }
    );

    const [activated, read] = toolTexts(result.messages);
    expect(activated).toContain('read them with read_file');
    expect(activated).toContain('- .agents/skills/deploy/deploy.sh');
    expect(read).toContain('echo deploy');
    expect(backend.getLastCall()?.tools?.some((t) => t.name === 'read_skill_file')).toBe(false);
    await workspace.dispose();
    await cog.close();
  });

  it('keeps code skills merging into the agent next to a SKILL.md source', async () => {
    const root = join(base, 'skills');
    addSkill(root, 'notes', 'Notes.', 'Take notes.');
    const ping = tool({
      name: 'ping',
      description: 'Ping',
      parameters: z.object({}),
      execute: async () => 'pong',
    });
    const agent = new Agent({
      name: 'mixed',
      model: 'mock/scripted',
      instructions: 'Base.',
      skills: [
        defineSkill({
          name: 'pinger',
          version: '1.0.0',
          description: 'Pings',
          tools: [ping],
          instructions: 'Ping often.',
        }),
        new SkillRegistry({ dirs: [root] }),
      ],
    });
    expect(agent.tools.map((t) => t.name)).toEqual(['ping']);
    expect(agent.instructions).toBe('Base.\n\nPing often.');

    const backend = new MockLLMBackend().setResponse({ content: 'Ok.' });
    const cog = cogitatorWith(backend);
    await cog.run(agent, { input: 'hi' });
    const request = backend.getLastCall()!;
    expect(String(request.messages[0]?.content)).toMatch(
      /^Base\.\n\nPing often\.\n\n<available_skills>/
    );
    expect(request.tools?.map((t) => t.name)).toEqual(['ping', 'use_skill', 'read_skill_file']);
    await cog.close();
  });

  it('gives an agent a handoff reaches its own skills in the system prompt', async () => {
    const root = join(base, 'skills');
    addSkill(root, 'billing-rules', 'Billing rules.', 'Refund within 30 days.');
    const billing = new Agent({
      name: 'billing',
      model: 'mock/scripted',
      instructions: 'You are billing.',
      skills: [new SkillRegistry({ dirs: [root] })],
    });
    const triage = new Agent({
      name: 'triage',
      model: 'mock/scripted',
      instructions: 'You are triage.',
      handoffs: [billing],
    });
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('h1', 'transfer_to_billing', {})] },
      { content: 'Billing here.' },
    ]);
    const cog = cogitatorWith(backend);
    await cog.run(triage, { input: 'refund' });

    const [first, second] = backend.getCalls();
    expect(first?.messages[0]?.content).toBe('You are triage.');
    expect(String(second?.messages[0]?.content)).toMatch(
      /^You are billing\.\n\n<available_skills>\n<skill name="billing-rules">/
    );
    expect(second?.tools?.some((t) => t.name === 'use_skill')).toBe(true);
    await cog.close();
  });
});

describe('availableSkillsSection', () => {
  it('lists names only past the description budget', () => {
    const skills = Array.from({ length: 40 }, (_, i) => ({
      name: `skill-${i}`,
      description: 'd'.repeat(1000),
      location: `/s/${i}`,
      source: 'host' as const,
    }));
    const section = availableSkillsSection(skills);
    const described = section.match(/<skill name="[^"]+">/g) ?? [];
    expect(described.length).toBeGreaterThan(0);
    expect(described.length * 1000).toBeLessThanOrEqual(MAX_SKILL_CATALOG_CHARS);
    expect(section).toContain('<skill name="skill-39"/>');
  });
});

function skillText(name: string, body: string, location = `/skills/${name}`): string {
  return `<skill_content name="${name}" source="host" location="${location}">\n${body}\n</skill_content>`;
}

function contextWith(state: Map<string, unknown>): RunMiddlewareContext {
  return {
    runId: 'r',
    agentId: 'a',
    agentName: 'a',
    iteration: 1,
    signal: new AbortController().signal,
    state,
  };
}

function useSkillTurn(id: string, text: string, name = 'use_skill'): Message[] {
  return [
    { role: 'assistant', content: '', toolCalls: [call(id, name, { skill: 'x' })] } as Message,
    { role: 'tool', content: text, toolCallId: id, name },
  ];
}

describe('use_skill results through clearing and compaction', () => {
  it('leaves the use_skill results of the run alone, the newest within the budget', async () => {
    const middleware = clearToolOutputsMiddleware({ trigger: 0, keep: 0 });
    const old = skillText('old', 'o'.repeat(30_000));
    const recent = skillText('recent', 'r'.repeat(30_000));
    const small = skillText('small', 's'.repeat(2_000));
    const messages: Message[] = [
      { role: 'system', content: 'Help.' },
      { role: 'user', content: 'go' },
      ...useSkillTurn('s1', old),
      ...useSkillTurn('s2', small),
      ...useSkillTurn('s3', recent),
      ...useSkillTurn('f1', 'y'.repeat(2000), 'fetch'),
    ];
    const state = new Map<string, unknown>([
      [PINNED_TOOL_OUTPUTS, new Map([['use_skill', 40_000]])],
    ]);
    const update = await middleware.beforeModel!({ messages, model: 'mock/m' }, contextWith(state));
    const after = update && 'messages' in update ? update.messages! : messages;
    expect(after[3]?.content).not.toBe(old);
    expect(after[5]?.content).toBe(small);
    expect(after[7]?.content).toBe(recent);
    expect(after[9]?.content).not.toBe('y'.repeat(2000));
  });

  it('clears a tool of your own named use_skill, which the run did not pin', async () => {
    const middleware = clearToolOutputsMiddleware({ trigger: 0, keep: 0 });
    const messages: Message[] = [
      { role: 'system', content: 'Help.' },
      ...useSkillTurn('s1', 'z'.repeat(3000)),
    ];
    const update = await middleware.beforeModel!(
      { messages, model: 'mock/m' },
      contextWith(new Map())
    );
    expect(update && 'messages' in update ? update.messages![2]?.content : undefined).not.toBe(
      'z'.repeat(3000)
    );
  });

  it('puts an active skill back after a compaction dropped it, once', () => {
    const text = skillText('pdf', 'Steps.');
    const before: Message[] = [
      { role: 'system', content: 'Help.' },
      ...useSkillTurn('s1', text),
      { role: 'user', content: 'next' },
    ];
    const compacted: Message[] = [
      { role: 'system', content: 'Help.' },
      { role: 'system', content: 'Summary of earlier turns.' },
      { role: 'user', content: 'next' },
    ];

    const kept = keepThroughCompaction(before, compacted);
    expect(kept).toEqual([
      { role: 'system', content: 'Help.' },
      { role: 'system', content: 'Summary of earlier turns.' },
      { role: 'system', content: text },
      { role: 'user', content: 'next' },
    ]);
    expect(keepThroughCompaction(kept, kept)).toEqual(kept);
    expect(keepThroughCompaction(kept, [kept[0]!, kept[3]!])).toEqual([kept[0], kept[2], kept[3]]);
    expect(keepThroughCompaction(before, before)).toEqual(before);
  });

  it('puts back at most the pinned budget of instructions, the newest, and names the rest', () => {
    const old = skillText('old', 'o'.repeat(30_000));
    const recent = skillText('recent', 'r'.repeat(30_000));
    const before: Message[] = [
      { role: 'system', content: 'Help.' },
      ...useSkillTurn('s1', old),
      ...useSkillTurn('s2', recent),
      { role: 'user', content: 'next' },
    ];
    const kept = keepThroughCompaction(before, [before[0]!, before[5]!]);
    expect(kept.map((m) => String(m.content).slice(0, 60))).toEqual([
      'Help.',
      recent.slice(0, 60),
      expect.stringContaining('Skills activated earlier whose instructions were left out'),
      'next',
    ]);
    expect(String(kept[2]?.content)).toContain('old');
  });

  it('keeps the compacted conversation and what it puts back within the window', async () => {
    class SmallWindow extends ContextManager {
      override getModelContextLimit(): number {
        return 1_000;
      }
    }
    const manager = new SmallWindow({ strategy: 'truncate', outputReserve: 0 });
    const conversation: Message[] = [
      { role: 'system', content: 'Help.' },
      ...useSkillTurn('s1', skillText('pdf', 'p'.repeat(1_000))),
    ];
    for (let i = 0; i < 12; i++) {
      conversation.push({ role: 'user', content: `question ${i} ${'q'.repeat(200)}` });
      conversation.push({ role: 'assistant', content: `answer ${i} ${'a'.repeat(200)}` });
    }
    const update = await compactionMiddleware(manager).beforeModel!(
      { messages: conversation, model: 'mock/m' },
      contextWith(new Map())
    );
    const compacted = update && 'messages' in update ? update.messages! : conversation;
    expect(compacted.some((m) => String(m.content).startsWith('<skill_content name="pdf"'))).toBe(
      true
    );
    expect(countMessagesTokens(compacted)).toBeLessThanOrEqual(1_000);
  });
});

describe('skills across a run', () => {
  it('loads the body of a skill of the same name the agent a handoff reaches has', async () => {
    const triageSkills = join(base, 'triage-skills');
    const billingSkills = join(base, 'billing-skills');
    addSkill(triageSkills, 'notes', 'Triage notes.', 'Triage body.');
    const billingFolder = addSkill(billingSkills, 'notes', 'Billing notes.', 'Billing body.');
    const billing = new Agent({
      name: 'billing',
      model: 'mock/m',
      instructions: 'Billing.',
      skills: [new SkillRegistry({ dirs: [billingSkills] })],
    });
    const triage = new Agent({
      name: 'triage',
      model: 'mock/m',
      instructions: 'Triage.',
      skills: [new SkillRegistry({ dirs: [triageSkills] })],
      handoffs: [billing],
    });
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('u1', 'use_skill', { skill: 'notes' })] },
      { toolCalls: [call('h1', 'transfer_to_billing', {})] },
      { toolCalls: [call('u2', 'use_skill', { skill: 'notes' })] },
      { content: 'Done.' },
    ]);
    const cog = cogitatorWith(backend);
    const result = await cog.run(triage, { input: 'refund' });

    const [first, , second] = toolTexts(result.messages);
    expect(first).toContain('Triage body.');
    expect(second).toContain('Billing body.');
    expect(second).toContain(`location="${billingFolder}"`);
    await cog.close();
  });

  it('drops kept instructions of skills the agent handed over to does not have', async () => {
    const triageSkills = join(base, 'triage-skills');
    const billingSkills = join(base, 'billing-skills');
    const triageFolder = addSkill(triageSkills, 'notes', 'Triage notes.', 'Triage body.');
    const billingFolder = addSkill(billingSkills, 'ledger', 'Ledger.', 'Ledger body.');
    const billing = new Agent({
      name: 'billing',
      model: 'mock/m',
      instructions: 'Billing.',
      skills: [new SkillRegistry({ dirs: [billingSkills] })],
    });
    const harness = new RunHarness({
      conversation: () => [],
      registry: () => new ToolRegistry(),
      workspaceOf: () => undefined,
      onTodos: async () => undefined,
      signal: new AbortController().signal,
    });
    await harness.prepare(billing);
    const messages: Message[] = [
      { role: 'system', content: 'Triage.' },
      { role: 'system', content: skillText('notes', 'Triage body.', triageFolder) },
      { role: 'system', content: skillText('ledger', 'Ledger body.', billingFolder) },
      { role: 'user', content: 'hi' },
    ];
    expect(harness.forHandoff(billing, messages)).toEqual([messages[0], messages[2], messages[3]]);
  });

  it('ends the run at its timeout while a skill loader is still searching', async () => {
    const hanging: SkillLoader = { discover: () => new Promise(() => undefined) };
    const backend = new MockLLMBackend().setResponse({ content: 'Hi.' });
    const cog = cogitatorWith(backend);
    const agent = new Agent({
      name: 'slow',
      model: 'mock/m',
      instructions: 'x',
      skills: [hanging],
      timeout: 50,
    });
    await expect(cog.run(agent, { input: 'hi' })).rejects.toThrow('timed out');
    expect(backend.getCallCount()).toBe(0);
    await cog.close();
  });

  it('fails a run whose skills configuration is invalid with a clear error', async () => {
    const backend = new MockLLMBackend().setResponse({ content: 'Hi.' });
    const cog = cogitatorWith(backend);
    const agent = new Agent({
      name: 'broken',
      model: 'mock/m',
      instructions: 'x',
      skills: [{ dirs: [''] }],
    });
    const error = await cog.run(agent, { input: 'hi' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CogitatorError);
    expect((error as CogitatorError).message).toContain('The skills of agent "broken" are invalid');
    await cog.close();
  });

  it('refuses an object that looks like a code skill but is not one', () => {
    expect(
      () =>
        new Agent({
          name: 'a',
          instructions: 'x',
          skills: [{ name: 'half', description: 'No version', tools: [] } as never],
        })
    ).toThrow('neither a skill made with defineSkill()');
  });
});
