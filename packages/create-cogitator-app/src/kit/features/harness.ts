import { code } from '../code.js';
import { runScript } from '../package-manager.js';
import { hasFeature } from '../spec.js';
import { cogitatorVersion, VERSIONS } from '../versions.js';
import type { FeatureModule } from './types.js';

const FACTS_TS = code`
  import { tool } from '@cogitator-ai/core';
  import { CoreFactsStore } from '@cogitator-ai/memory';
  import { z } from 'zod';

  /** Lasting facts about the user (name, time zone, preferences) and the tools that keep them. */
  export function createFacts(path: string) {
    const store = new CoreFactsStore({ path });
    let opened: Promise<void> | undefined;
    /** Opens the database on first use, so importing this module touches no file. */
    const ready = () => (opened ??= store.initialize());

    const rememberFact = tool({
      name: 'remember_fact',
      description:
        'Remember a lasting fact about the user, such as their name, time zone or a preference. Overwrites the fact with the same key.',
      parameters: z.object({
        key: z.string().min(1).max(64).describe('A short key, e.g. "name" or "timezone"'),
        value: z.string().min(1).max(500).describe('What to remember'),
      }),
      execute: async ({ key, value }) => {
        await ready();
        await store.set(key, value);
        return { remembered: key };
      },
    });

    const forgetFact = tool({
      name: 'forget_fact',
      description: 'Forget a fact about the user when they ask you to or it is no longer true.',
      parameters: z.object({ key: z.string().min(1).describe('The key of the fact') }),
      execute: async ({ key }) => {
        await ready();
        await store.delete(key);
        return { forgotten: key };
      },
    });

    /** Every fact, as run context, so the assistant knows them from the first message of a run. */
    async function context(): Promise<Record<string, string>> {
      await ready();
      return store.getAll();
    }

    async function close(): Promise<void> {
      if (!opened) return;
      await opened;
      await store.close();
    }

    return { store, rememberFact, forgetFact, tools: [rememberFact, forgetFact], context, close };
  }

  export const facts = createFacts(process.env.FACTS_PATH ?? './data/facts.db');
  export const factTools = facts.tools;
`;

const SCHEDULER_TS = code`
  import { HeartbeatScheduler, SimpleTimerStore, getNextCronMs } from '@cogitator-ai/channels';
  import { createSchedulerTools } from '@cogitator-ai/core';

  /** Tasks the assistant schedules for later, kept on disk so they survive a restart. */
  export const timerStore = new SimpleTimerStore({
    persistPath: process.env.TIMERS_PATH ?? './data/timers.json',
    resolveCronFiresAt: (cron, timezone) => getNextCronMs(cron, Date.now(), timezone),
  });

  /** schedule_task, list_tasks and cancel_task: "remind me in 20 minutes", "every morning at 9". */
  export const schedulerTools = createSchedulerTools({ store: timerStore, defaultChannel: 'terminal' });

  /** Calls \`onTask\` with each task that comes due while the process runs. */
  export function startScheduler(onTask: (task: string) => Promise<void>): HeartbeatScheduler {
    const scheduler = new HeartbeatScheduler(timerStore, {
      onFire: (message) => onTask(message.text),
      pollInterval: 10_000,
      onError: (error) => console.error(\`Scheduled task failed: \${error.message}\`),
    });
    scheduler.start();
    return scheduler;
  }
`;

const HARNESS_TEST_TS = code`
  import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import type { MockChatResponse } from '@cogitator-ai/test-utils';
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { createAssistant } from '../src/agents/assistant.js';
  import { createFacts } from '../src/harness/facts.js';
  import { mockCogitator } from './helpers.js';

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const context = { agentId: 'test', runId: 'test', signal: new AbortController().signal };

  function toolCall(name: string, args: Record<string, unknown>): MockChatResponse {
    return { toolCalls: [{ id: \`call-\${name}\`, name, arguments: args }], finishReason: 'tool_calls' };
  }

  /** Runs the assistant on the scripted model turns, answering every approval with \`approved\`. */
  async function run(turns: MockChatResponse[], approved: boolean) {
    const workspace = join(dir, 'workspace');
    const harness = createAssistant(workspace);
    const { cogitator } = mockCogitator(...turns, { content: 'Done.' });
    const asked: string[] = [];
    try {
      await cogitator.run(harness.agent, {
        input: 'Write hello to notes.md',
        ...harness.runOptions,
        onApproval: (request) => {
          asked.push(request.toolName);
          return approved ? { approved: true } : { approved: false, reason: 'not now' };
        },
      });
      return { workspace, asked };
    } finally {
      await cogitator.close();
      await harness.dispose();
    }
  }

  describe('workspace', () => {
    it('writes relative paths into the workspace once approved', async () => {
      const { workspace } = await run([toolCall('write_file', { path: 'notes.md', content: 'hello' })], true);
      expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('hello');
    });

    it('writes nothing when the write is declined', async () => {
      const { workspace } = await run([toolCall('write_file', { path: 'notes.md', content: 'hello' })], false);
      expect(existsSync(join(workspace, 'notes.md'))).toBe(false);
    });

    it('asks before writing, never before reading', async () => {
      const { asked } = await run(
        [toolCall('list_files', {}), toolCall('write_file', { path: 'notes.md', content: 'hello' })],
        true
      );
      expect(asked).toEqual(['write_file']);
    });

    it('cannot reach outside the workspace, also through a symlink', async () => {
      const workspace = join(dir, 'workspace');
      const harness = createAssistant(workspace);
      const readFile = harness.agent.tools.find((tool) => tool.name === 'read_file');
      mkdirSync(workspace, { recursive: true });
      symlinkSync(dir, join(workspace, 'escape'));

      for (const path of ['../secret.txt', '/etc/passwd', 'escape/secret.txt']) {
        await expect(readFile?.execute({ path }, context), path).rejects.toThrow('outside the workspace');
      }
      await harness.dispose();
    });

    it('runs no shell commands', () => {
      const harness = createAssistant(join(dir, 'workspace'));
      expect(harness.agent.tools.map((tool) => tool.name)).not.toContain('run_command');
    });
  });

  describe('facts', () => {
    it('remembers, recalls and forgets facts across restarts', async () => {
      const path = join(dir, 'facts.db');
      const first = createFacts(path);
      await first.rememberFact.execute({ key: 'name', value: 'Ada' }, context);
      await first.close();

      const second = createFacts(path);
      expect(await second.context()).toEqual({ name: 'Ada' });
      await second.forgetFact.execute({ key: 'name' }, context);
      expect(await second.context()).toEqual({});
      await second.close();
    });
  });
`;

/**
 * The assistant harness: the assistant becomes a harness agent of core (a workspace it reads and
 * writes with your approval, todos, skills), with facts it keeps about you and tasks it schedules
 * for later.
 */
export const harnessFeature: FeatureModule = {
  id: 'feature:harness',
  applies: (spec) => hasFeature(spec, 'harness'),
  apply(project) {
    project
      .dependency('@cogitator-ai/memory', cogitatorVersion('@cogitator-ai/memory'))
      .dependency('@cogitator-ai/channels', cogitatorVersion('@cogitator-ai/channels'))
      .dependency('better-sqlite3', VERSIONS.betterSqlite3)
      .allowBuild('better-sqlite3')
      .file('src/harness/facts.ts', FACTS_TS)
      .file('src/harness/scheduler.ts', SCHEDULER_TS)
      .file('tests/harness.test.ts', HARNESS_TEST_TS)
      .toolSet('factTools', '../harness/facts.js')
      .toolSet('schedulerTools', '../harness/scheduler.js')
      .ignore('workspace/', 'data/')
      .envVar({
        name: 'WORKSPACE_DIR',
        description: 'The directory the assistant may read and write',
        example: 'workspace',
        required: false,
        secret: false,
      })
      .instruct(
        'Remember lasting facts about the user with remember_fact, and schedule reminders and recurring work with schedule_task.'
      );
  },
  finalize(project) {
    const pm = project.spec.packageManager;
    project.section(
      'Assistant harness',
      code`
        - \`src/agents/assistant.ts\`: the assistant is \`createHarnessAgent({ preset: 'assistant' })\` from core: file tools confined to \`workspace/\` (\`WORKSPACE_DIR\`), no shell, \`write_todos\` for longer tasks, the skills of \`workspace/.agents/skills\`, long tool results kept as files in the workspace, and the permission engine: reads run freely, \`write_file\` and \`edit_file\` need approval and the terminal chat asks before they run. Pass options to \`createHarnessAgent\` to change any of it (\`permissions: { mode: 'acceptEdits' }\`, \`shell: true\`, \`skills: { dirs: ['skills'] }\`), \`src/cogitator.ts\` merges its runtime settings (\`assistantHarness.mergeConfig\`).
        - \`src/harness/facts.ts\`: \`remember_fact\` and \`forget_fact\` keep lasting facts in \`data/facts.db\` (\`CoreFactsStore\`), and every run gets them as context.
        - \`src/harness/scheduler.ts\`: \`schedule_task\`, \`list_tasks\` and \`cancel_task\`. Tasks are kept in \`data/timers.json\`, and while \`${runScript(pm, 'dev')}\` runs, a due task is handed to the assistant like a message.
      `
    );
  },
};
