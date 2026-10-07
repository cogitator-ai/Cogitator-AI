import { code } from '../code.js';
import { runScript } from '../package-manager.js';
import { hasFeature } from '../spec.js';
import { cogitatorVersion, VERSIONS } from '../versions.js';
import type { FeatureModule } from './types.js';

const WORKSPACE_TS = code`
  import { mkdirSync } from 'node:fs';
  import { resolve } from 'node:path';
  import { fileDelete, fileExists, fileList, fileRead, fileWrite, restrictFileTools } from '@cogitator-ai/core';

  /**
   * File tools confined to \`root\`: paths are relative to it, nothing outside it
   * is reachable (symlinks included), and writing or deleting waits for approval.
   */
  export function createWorkspaceTools(root: string) {
    const workspace = resolve(root);
    mkdirSync(workspace, { recursive: true });
    return restrictFileTools([fileRead, fileList, fileExists, fileWrite, fileDelete], [workspace], {
      base: workspace,
      requireApproval: (tool) => tool.sideEffects?.includes('filesystem') ?? false,
    });
  }

  /** The directory the assistant works in: ./workspace, or WORKSPACE_DIR. */
  export const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? 'workspace';

  export const workspaceTools = createWorkspaceTools(WORKSPACE_DIR);
`;

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
  import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { Agent } from '@cogitator-ai/core';
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { createFacts } from '../src/harness/facts.js';
  import { createWorkspaceTools } from '../src/harness/workspace.js';
  import { mockCogitator } from './helpers.js';

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const context = { agentId: 'test', runId: 'test', signal: new AbortController().signal };

  function writeCall(path: string) {
    return {
      toolCalls: [{ id: 'call-1', name: 'file_write', arguments: { path, content: 'hello' } }],
      finishReason: 'tool_calls' as const,
    };
  }

  async function runWrite(path: string, approved: boolean) {
    const workspace = join(dir, 'workspace');
    const agent = new Agent({ name: 'writer', instructions: 'Write files.', tools: createWorkspaceTools(workspace) });
    const { cogitator } = mockCogitator(writeCall(path), { content: 'Done.' });
    try {
      const result = await cogitator.run(agent, {
        input: 'Write hello to notes.md',
        onApproval: () => (approved ? { approved: true } : { approved: false, reason: 'not now' }),
      });
      return { result, workspace };
    } finally {
      await cogitator.close();
    }
  }

  describe('workspace tools', () => {
    it('writes relative paths into the workspace once approved', async () => {
      const { workspace } = await runWrite('notes.md', true);
      expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('hello');
    });

    it('writes nothing when the write is declined', async () => {
      const { workspace } = await runWrite('notes.md', false);
      expect(existsSync(join(workspace, 'notes.md'))).toBe(false);
    });

    it('cannot reach outside the workspace, also through a symlink', async () => {
      const workspace = join(dir, 'workspace');
      const [fileRead] = createWorkspaceTools(workspace);
      symlinkSync(dir, join(workspace, 'escape'));

      for (const path of ['../secret.txt', '/etc/passwd', 'escape/secret.txt']) {
        const result = (await fileRead.execute({ path }, context)) as { error?: string };
        expect(result.error, path).toContain('Access denied');
      }
    });

    it('asks before writing and deleting, never before reading', () => {
      const tools = createWorkspaceTools(join(dir, 'workspace'));
      const needApproval = tools.filter((tool) => tool.requiresApproval).map((tool) => tool.name);
      expect(needApproval.sort()).toEqual(['file_delete', 'file_write']);
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
 * The assistant harness: a workspace the agent can read and write with your
 * approval, facts it keeps about you, and tasks it schedules for later.
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
      .file('src/harness/workspace.ts', WORKSPACE_TS)
      .file('src/harness/facts.ts', FACTS_TS)
      .file('src/harness/scheduler.ts', SCHEDULER_TS)
      .file('tests/harness.test.ts', HARNESS_TEST_TS)
      .toolSet('workspaceTools', '../harness/workspace.js')
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
        'You have a workspace for files: read them freely, and know that writing or deleting needs the user to approve it.'
      )
      .instruct(
        'Remember lasting facts about the user with remember_fact, and schedule reminders and recurring work with schedule_task.'
      );
  },
  finalize(project) {
    const pm = project.spec.packageManager;
    project.section(
      'Assistant harness',
      code`
        - \`src/harness/workspace.ts\`: file tools confined to \`workspace/\` (\`WORKSPACE_DIR\`) with \`restrictFileTools\` from core. Paths are relative to it, symlinks out of it are refused, and \`file_write\` and \`file_delete\` need approval: the terminal chat asks before they run.
        - \`src/harness/facts.ts\`: \`remember_fact\` and \`forget_fact\` keep lasting facts in \`data/facts.db\` (\`CoreFactsStore\`), and every run gets them as context.
        - \`src/harness/scheduler.ts\`: \`schedule_task\`, \`list_tasks\` and \`cancel_task\`. Tasks are kept in \`data/timers.json\`, and while \`${runScript(pm, 'dev')}\` runs, a due task is handed to the assistant like a message.
      `
    );
  },
};
