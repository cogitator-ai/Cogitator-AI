import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createCogitator, header, section } from '../_shared/setup.js';
import { Agent, LocalWorkspace, tool, workspaceTools } from '@cogitator-ai/core';

const MODEL = process.env.EXAMPLE_MODEL ?? `ollama/${process.env.OLLAMA_MODEL ?? 'qwen2.5:0.5b'}`;

const REVIEWER = `---
name: reviewer
description: Reviews a file and reports problems. Use it after edits.
tools: Read, Grep, Glob
permissionMode: plan
maxTurns: 4
---

You are a careful reviewer. Read the file you are given and report problems in one short paragraph.
`;

const RELEASER = `---
name: releaser
description: Publishes a release with the publish tool.
tools: publish
---

You publish releases. Call publish with the version you are given, then confirm in one sentence.
`;

const COMMAND = `---
description: Review a file
argument-hint: "[path]"
---

Ask the reviewer subagent to review $0, then tell me what it found.
`;

const publish = tool({
  name: 'publish',
  description: 'Publishes a release',
  parameters: z.object({ version: z.string() }),
  requiresApproval: true,
  execute: async ({ version }) => `published ${version}`,
});

async function main() {
  header('28 - Subagents and commands from .claude/ files');

  const root = mkdtempSync(join(tmpdir(), 'cogitator-subagents-'));
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(root, '.claude', 'agents', 'reviewer.md'), REVIEWER);
  writeFileSync(join(root, '.claude', 'agents', 'releaser.md'), RELEASER);
  writeFileSync(join(root, '.claude', 'commands', 'review.md'), COMMAND);
  writeFileSync(join(root, 'app.ts'), 'export const add = (a: number, b: number) => a - b;\n');
  const workspace = new LocalWorkspace({ root });
  await workspace.start();

  try {
    const files = { root, trusted: true, userDirs: [], managedDirs: [] };
    const cog = createCogitator({
      memory: { adapter: 'memory' },
      permissions: {},
      subagents: {
        files,
        approvalMode: 'bubble',
        onDelegationStart: (event) => console.log(`  -> ${event.agent}: ${event.task}`),
        onDelegationComplete: (event) => console.log(`  <- ${event.agent} ${event.status}`),
      },
      commands: { files },
    });

    section('What the project defines');
    const agents = await cog.listSubagents({ root });
    for (const agent of agents.agents)
      console.log(`  subagent ${agent.name}: ${agent.description}`);
    const commands = await cog.listCommands({ root });
    for (const command of commands.commands) {
      console.log(`  /${command.name} ${command.argumentHint ?? ''}: ${command.description ?? ''}`);
    }

    const lead = new Agent({
      name: 'lead',
      model: MODEL,
      instructions:
        'You lead the work. Delegate with the agent tool: reviews to reviewer, releases to releaser.',
      tools: [...workspaceTools(), publish],
      workspace,
      maxIterations: 6,
    });

    section('A command expands into the message the run gets');
    const reviewed = await cog.run(lead, { input: '/review app.ts', threadId: 'review' });
    console.log(`  command: /${reviewed.command?.name}, input: ${reviewed.command?.input}`);
    console.log(`  answer: ${reviewed.output.slice(0, 240)}`);

    section('An approval of the releaser bubbles up to the lead');
    const paused = await cog.run(lead, {
      input: 'Ask the releaser subagent to publish version 2.4.0.',
      threadId: 'release',
    });
    if (paused.status === 'paused') {
      for (const request of paused.pendingApprovals ?? []) {
        console.log(`  waiting: ${request.toolName} (${request.toolCallId})`);
      }
      const done = await cog.resume(lead, 'release', { defaultDecision: { approved: true } });
      console.log(`  after approval: ${done.output.slice(0, 240)}`);
    } else {
      console.log(`  the model did not delegate: ${paused.output.slice(0, 240)}`);
    }

    await cog.close();
  } finally {
    await workspace.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
