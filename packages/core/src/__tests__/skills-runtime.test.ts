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
import { keepThroughCompaction } from '../cogitator/harness';
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
      '<skill_content name="pdf">\nRun scripts/extract.py on the file.\n</skill_content>'
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

describe('use_skill results through clearing and compaction', () => {
  it('never clears a use_skill result', async () => {
    const middleware = clearToolOutputsMiddleware({ trigger: 0, keep: 0 });
    const skillText = `<skill_content name="pdf">\n${'x'.repeat(2000)}\n</skill_content>`;
    const messages: Message[] = [
      { role: 'system', content: 'Help.' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [call('s1', 'use_skill', { skill: 'pdf' })],
      } as Message,
      { role: 'tool', content: skillText, toolCallId: 's1', name: 'use_skill' },
      { role: 'assistant', content: '', toolCalls: [call('f1', 'fetch', {})] } as Message,
      { role: 'tool', content: 'y'.repeat(2000), toolCallId: 'f1', name: 'fetch' },
    ];
    const update = await middleware.beforeModel!(
      { messages, model: 'mock/m' },
      {
        runId: 'r',
        agentId: 'a',
        agentName: 'a',
        iteration: 1,
        signal: new AbortController().signal,
        state: new Map(),
      }
    );
    const after = update && 'messages' in update ? update.messages! : messages;
    expect(after[3]?.content).toBe(skillText);
    expect(after[5]?.content).not.toBe('y'.repeat(2000));
  });

  it('puts an active skill back after a compaction dropped it, once', () => {
    const skillText = '<skill_content name="pdf">\nSteps.\n</skill_content>';
    const before: Message[] = [
      { role: 'system', content: 'Help.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [call('s1', 'use_skill', { skill: 'pdf' })],
      } as Message,
      { role: 'tool', content: skillText, toolCallId: 's1', name: 'use_skill' },
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
      { role: 'system', content: skillText },
      { role: 'user', content: 'next' },
    ]);
    expect(keepThroughCompaction(kept, kept)).toEqual(kept);
    expect(keepThroughCompaction(before, before)).toEqual(before);
  });
});
