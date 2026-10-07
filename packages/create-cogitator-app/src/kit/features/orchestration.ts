import { code } from '../code.js';
import type { ProjectBuilder } from '../project.js';
import { runScript } from '../package-manager.js';
import { hasFeature, primaryTarget } from '../spec.js';
import { cogitatorVersion } from '../versions.js';
import { startupImports, startupStatements } from './shared.js';
import type { FeatureModule } from './types.js';

const RESEARCHER_TS = code`
  import { Agent } from '@cogitator-ai/core';
  import { currentTime } from '../tools/current-time.js';
  import { fetchUrl } from '../tools/fetch-url.js';

  export const researcher = new Agent({
    name: 'researcher',
    description: 'Collects facts and sources on a topic',
    instructions: [
      'You research a topic and report the facts that matter, as short bullet points.',
      'Read sources with fetch_url when they help, and name each source you used.',
      'Mark anything you are not sure about.',
    ].join('\\n'),
    tools: [fetchUrl, currentTime],
    temperature: 0.3,
  });
`;

const WRITER_TS = code`
  import { Agent } from '@cogitator-ai/core';

  export const writer = new Agent({
    name: 'writer',
    description: 'Turns notes into clear, well-structured prose',
    instructions: [
      'You write clear, well-structured text from the notes you are given.',
      'Use a title, a short introduction and sections with headings. Do not invent facts.',
    ].join('\\n'),
    temperature: 0.7,
  });
`;

const REVIEWER_TS = code`
  import { Agent } from '@cogitator-ai/core';

  export const reviewer = new Agent({
    name: 'reviewer',
    description: 'Leads the team: delegates research and writing, then checks the result',
    instructions: [
      'You lead a small team: a researcher and a writer.',
      'Delegate the research first, then the writing, and check the draft for accuracy and clarity before you answer with the final text.',
    ].join('\\n'),
    temperature: 0.2,
  });
`;

/** The researcher and writer agents the workflow and the swarm share, added once. */
function addTeamAgents(project: ProjectBuilder): void {
  if (project.files.has('src/agents/researcher.ts')) return;
  project
    .file('src/agents/researcher.ts', RESEARCHER_TS)
    .file('src/agents/writer.ts', WRITER_TS)
    .register({
      kind: 'agents',
      name: 'researcher',
      from: './agents/researcher.js',
      binding: 'researcher',
    })
    .register({ kind: 'agents', name: 'writer', from: './agents/writer.js', binding: 'writer' });
}

const REPORT_WORKFLOW_TS = code`
  import { WorkflowBuilder, agentNode } from '@cogitator-ai/workflows';
  import { researcher } from '../agents/researcher.js';
  import { writer } from '../agents/writer.js';

  export type ReportState = {
    topic: string;
    notes?: string;
    report?: string;
  };

  const research = agentNode<ReportState>(researcher, {
    inputMapper: (state) => \`Research this topic and list the key facts: \${state.topic}\`,
    stateMapper: (result) => ({ notes: result.output }),
  });

  const write = agentNode<ReportState>(writer, {
    inputMapper: (state) => \`Write a short report on "\${state.topic}" from these notes:\\n\\n\${state.notes ?? ''}\`,
    stateMapper: (result) => ({ report: result.output }),
  });

  /** Research a topic, then write a report from the notes: two agents in a DAG. */
  export const reportWorkflow = new WorkflowBuilder<ReportState>('report')
    .initialState({ topic: '' })
    .addNode('research', research)
    .addNode('write', write, { after: ['research'] })
    .entryPoint('research')
    .build();
`;

const REPORT_TEST_TS = code`
  import { WorkflowExecutor } from '@cogitator-ai/workflows';
  import { describe, expect, it } from 'vitest';
  import { workflows } from '../src/cogitator.js';
  import { mockCogitator } from './helpers.js';

  describe('report workflow', () => {
    it('researches first, then writes the report from the notes', async () => {
      const { cogitator, backend } = mockCogitator(
        { content: '- Fact one\\n- Fact two' },
        { content: '# Report\\n\\nFact one and fact two.' }
      );
      try {
        const result = await new WorkflowExecutor(cogitator).execute(workflows.report, { topic: 'testing' });

        expect(result.error).toBeUndefined();
        expect(result.state.notes).toBe('- Fact one\\n- Fact two');
        expect(result.state.report).toBe('# Report\\n\\nFact one and fact two.');
        expect(JSON.stringify(backend.getLastCall()?.messages)).toContain('Fact two');
      } finally {
        await cogitator.close();
      }
    });
  });
`;

function workflowEntry(project: ProjectBuilder): string {
  return code`
    import { createInterface } from 'node:readline/promises';
    import { styleText } from 'node:util';
    import { WorkflowExecutor } from '@cogitator-ai/workflows';
    import { cogitator, workflows } from './cogitator.js';
    import { loadEnv } from './env.js';
    ${startupImports(project)}

    async function topicFromUser(): Promise<string> {
      const fromArgs = process.argv.slice(2).join(' ').trim();
      if (fromArgs) return fromArgs;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question('Topic for the report: ')).trim();
      } finally {
        rl.close();
      }
    }

    async function main(): Promise<void> {
      loadEnv();
      ${startupStatements(project)}
      const topic = await topicFromUser();
      if (!topic) throw new Error('Give the report a topic');

      const result = await new WorkflowExecutor(cogitator).execute(
        workflows.report,
        { topic },
        {
          onNodeStart: (node) => console.error(styleText('dim', \`> \${node}\`)),
          onNodeComplete: (node, _output, duration) =>
            console.error(styleText('dim', \`  \${node} done in \${(duration / 1000).toFixed(1)}s\`)),
        }
      );
      if (result.error) throw result.error;
      console.log(result.state.report);
    }

    main()
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      })
      .finally(() => cogitator.close());
  `;
}

export const workflowsFeature: FeatureModule = {
  id: 'feature:workflows',
  applies: (spec) => hasFeature(spec, 'workflows'),
  apply(project) {
    addTeamAgents(project);
    project
      .dependency('@cogitator-ai/workflows', cogitatorVersion('@cogitator-ai/workflows'))
      .file('src/workflows/report.ts', REPORT_WORKFLOW_TS)
      .file('tests/report.test.ts', REPORT_TEST_TS)
      .register({
        kind: 'workflows',
        name: 'report',
        from: './workflows/report.js',
        binding: 'reportWorkflow',
      });
  },
  finalize(project) {
    const { spec } = project;
    if (
      spec.app === 'script' &&
      primaryTarget(spec) === 'workflow' &&
      !hasFeature(spec, 'durable')
    ) {
      project.file('src/index.ts', workflowEntry(project));
    }
    project.section(
      'Workflows',
      code`
        \`src/workflows/report.ts\` is a DAG built with \`WorkflowBuilder\`: \`research\` runs the researcher, \`write\` runs the writer on its notes. Nodes are \`agentNode\`s (an agent) or \`functionNode\`s (your code), and \`after\` sets the order. Workflows are registered in \`src/cogitator.ts\`; \`tests/report.test.ts\` shows how to run one against a mocked model.
      `
    );
  },
};

const PUBLISH_WORKFLOW_TS = code`
  import { mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
  import { join } from 'node:path';
  import { WorkflowBuilder, agentNode, approvalNode, functionNode, humanWorkflowNode } from '@cogitator-ai/workflows';
  import { writer } from '../agents/writer.js';

  export type PublishState = {
    topic: string;
    draft?: string;
    approved?: boolean;
    path?: string;
    outcome?: 'published' | 'discarded';
  };

  /** Where published posts go; tests point it at a temporary directory. */
  export function publishDirectory(): string {
    return process.env.PUBLISH_DIR ?? 'out';
  }

  function slug(topic: string): string {
    return topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'post';
  }

  const draft = agentNode<PublishState>(writer, {
    inputMapper: (state) => \`Write a short blog post about: \${state.topic}\`,
    stateMapper: (result) => ({ draft: result.output }),
  });

  /** A person approves the draft. The request survives restarts: it lives in the approval store. */
  const review = humanWorkflowNode(
    approvalNode<PublishState>('review', {
      title: 'Publish this post?',
      description: (state) => (state.draft ?? '').slice(0, 1_000),
      timeout: 24 * 60 * 60 * 1000,
      timeoutAction: 'reject',
    }),
    { stateMapper: (result) => ({ approved: result.approved }) }
  );

  /** Writes the post; its compensation deletes it again when a later step fails. */
  const publish = functionNode<PublishState, string>(
    'publish',
    async (state) => {
      await mkdir(publishDirectory(), { recursive: true });
      const path = join(publishDirectory(), \`\${slug(state.topic)}.md\`);
      await writeFile(path, state.draft ?? '');
      return path;
    },
    { stateMapper: (path) => ({ path }) }
  );

  /** Records the post in the changelog. Set FAIL_ANNOUNCE=1 to watch the saga roll back the publish. */
  const announce = functionNode<PublishState, void>('announce', async (state) => {
    if (process.env.FAIL_ANNOUNCE === '1') throw new Error('The announcement failed');
    await appendFile(join(publishDirectory(), 'CHANGELOG.md'), \`- \${new Date().toISOString()} \${state.topic}\\n\`);
  });

  const discard = functionNode<PublishState, 'discarded'>('discard', async () => 'discarded', {
    stateMapper: (outcome) => ({ outcome }),
  });

  /**
   * Draft, approve, publish, announce: a saga. The approval waits for a person
   * and survives restarts, and a failed announcement unpublishes the post.
   */
  export const publishWorkflow = new WorkflowBuilder<PublishState>('publish')
    .initialState({ topic: '' })
    .addNode('draft', draft)
    .addNode('review', review, { after: ['draft'] })
    .addConditional('decide', (state) => (state.approved ? 'publish' : 'discard'), { after: ['review'] })
    .addNode('publish', publish, {
      after: ['decide'],
      config: {
        compensation: {
          compensate: async (state) => {
            if (state.path) await rm(state.path, { force: true });
          },
        },
      },
    })
    .addNode('announce', announce, { after: ['publish'] })
    .addNode('discard', discard, { after: ['decide'] })
    .entryPoint('draft')
    .build();
`;

const DURABLE_RUNTIME_TS = code`
  import type { Cogitator } from '@cogitator-ai/core';
  import { FileApprovalStore, FileCheckpointStore, createFileRunStore, createWorkflowManager } from '@cogitator-ai/workflows';
  import { cogitator, workflows } from './cogitator.js';

  /**
   * The workflow manager with runs, checkpoints and approvals on disk under
   * \`directory\`: another process (\`approve\`) can answer an approval, and
   * \`recoverRuns\` continues the runs a crash interrupted.
   */
  export function createDurableRuntime(runtime: Cogitator, directory: string) {
    const approvalStore = new FileApprovalStore({ directory: \`\${directory}/approvals\`, pollInterval: 500 });
    const manager = createWorkflowManager({
      cogitator: runtime,
      runStore: createFileRunStore({ directory: \`\${directory}/runs\` }),
      checkpointStore: new FileCheckpointStore(\`\${directory}/checkpoints\`),
    });
    manager.registerWorkflow(workflows.publish);
    return { manager, approvalStore };
  }

  export const { manager, approvalStore } = createDurableRuntime(cogitator, '.cogitator/workflows');
`;

function durableEntry(project: ProjectBuilder): string {
  return code`
  import { styleText } from 'node:util';
  import type { WorkflowRun } from '@cogitator-ai/workflows';
  import { cogitator, workflows } from './cogitator.js';
  import { approvalStore, manager } from './durable.js';
  import { loadEnv } from './env.js';
  ${startupImports(project)}

  const FINISHED = new Set<WorkflowRun['status']>(['completed', 'failed', 'cancelled']);

  /** Resolves when every run in \`runIds\` has finished, printing each change of status. */
  function untilFinished(runIds: Set<string>): Promise<void> {
    return new Promise((resolve) => {
      if (runIds.size === 0) return resolve();
      const stop = manager.onRunStateChange((run) => {
        if (!runIds.has(run.id)) return;
        console.error(styleText('dim', \`  run \${run.id}: \${run.status}\`));
        if (!FINISHED.has(run.status)) return;
        runIds.delete(run.id);
        if (runIds.size === 0) {
          stop();
          resolve();
        }
      });
    });
  }

  const options = {
    approvalStore,
    onApprovalRequired: () =>
      console.error(styleText('yellow', 'Waiting for approval: answer it with the approve script in another terminal')),
    onCompensationStart: (node: string) => console.error(styleText('yellow', \`Rolling back \${node}\`)),
  };

  async function main(): Promise<void> {
    loadEnv();
    ${startupStatements(project)}
    manager.start();

    const recovered = await manager.recoverRuns(options);
    if (recovered.resumed.length > 0) {
      console.error(\`Continuing \${recovered.resumed.length} run(s) a previous process left unfinished\`);
    }
    const waiting = untilFinished(new Set(recovered.resumed));

    const topic = process.argv.slice(2).join(' ').trim();
    if (topic) {
      const result = await manager.execute(workflows.publish, { topic }, options);
      if (result.error) throw result.error;
      console.log(result.state.outcome === 'discarded' ? 'The post was not approved.' : \`Published \${result.state.path}\`);
    } else if (recovered.resumed.length === 0) {
      console.log('Nothing to do. Start a run with a topic: the start script followed by the topic.');
    }

    await waiting;
  }

  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(async () => {
      manager.dispose();
      await cogitator.close();
    });
`;
}

const APPROVE_TS = code`
  import { createInterface } from 'node:readline/promises';
  import { approvalStore } from './durable.js';

  /** Answers the approvals the publish workflow is waiting for, from any terminal. */
  async function main(): Promise<void> {
    const pending = await approvalStore.getPendingRequests();
    if (pending.length === 0) {
      console.log('No approvals are waiting.');
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const request of pending) {
        console.log(\`\\n\${request.title}\\n\\n\${request.description ?? ''}\\n\`);
        const answer = (await rl.question('Approve? [y/N] ')).trim();
        await approvalStore.submitResponse({
          requestId: request.id,
          decision: /^y(es)?$/i.test(answer),
          respondedBy: process.env.USER ?? 'terminal',
          respondedAt: Date.now(),
        });
      }
    } finally {
      rl.close();
    }
  }

  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
`;

const START_PUBLISH_FIXTURE_TS = code`
  import { workflows } from '../../src/cogitator.js';
  import { createDurableRuntime } from '../../src/durable.js';
  import { mockCogitator } from '../helpers.js';

  /** Starts a publish run on a mocked model and says WAITING once it asks for approval. The test kills it there. */
  const [stateDir = '.cogitator/workflows'] = process.argv.slice(2);
  const { cogitator } = mockCogitator({ content: '# Hello\\n\\nA post.' });
  const { manager, approvalStore } = createDurableRuntime(cogitator, stateDir);
  await manager.execute(
    workflows.publish,
    { topic: 'Hello World' },
    { approvalStore, onApprovalRequired: () => console.log('WAITING') }
  );
`;

const PUBLISH_TEST_TS = code`
  import { spawn } from 'node:child_process';
  import { once } from 'node:events';
  import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { InMemoryApprovalStore, WorkflowExecutor } from '@cogitator-ai/workflows';
  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
  import { workflows } from '../src/cogitator.js';
  import { createDurableRuntime } from '../src/durable.js';
  import { mockCogitator } from './helpers.js';

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'publish-'));
    vi.stubEnv('PUBLISH_DIR', dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the workflow and answers its approval request with \`decision\` as soon as it is asked. */
  async function runApproved(decision: boolean) {
    const { cogitator } = mockCogitator({ content: '# Hello\\n\\nA post.' });
    const approvalStore = new InMemoryApprovalStore();
    try {
      return await new WorkflowExecutor(cogitator).execute(
        workflows.publish,
        { topic: 'Hello World' },
        {
          approvalStore,
          onApprovalRequired: (request) => {
            void approvalStore.submitResponse({
              requestId: request.id,
              decision,
              respondedBy: 'test',
              respondedAt: Date.now(),
            });
          },
        }
      );
    } finally {
      await cogitator.close();
    }
  }

  describe('publish workflow', () => {
    it('publishes and announces an approved post', async () => {
      const result = await runApproved(true);
      expect(result.error).toBeUndefined();
      expect(readFileSync(join(dir, 'hello-world.md'), 'utf8')).toContain('A post.');
      expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toContain('Hello World');
    });

    it('discards a rejected post', async () => {
      const result = await runApproved(false);
      expect(result.state.outcome).toBe('discarded');
      expect(existsSync(join(dir, 'hello-world.md'))).toBe(false);
    });

    it('unpublishes the post when the announcement fails', async () => {
      vi.stubEnv('FAIL_ANNOUNCE', '1');
      const result = await runApproved(true);
      expect(result.error?.message).toContain('announcement failed');
      expect(existsSync(join(dir, 'hello-world.md'))).toBe(false);
    });

    it('finishes a run waiting for approval after the process that started it was killed', async () => {
      const stateDir = join(dir, 'state');
      const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/start-publish.ts', stateDir], {
        env: { ...process.env, PUBLISH_DIR: dir },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('WAITING')) resolve();
        });
        child.once('exit', (code) => reject(new Error(\`The run exited with \${code} before asking for approval\`)));
      });
      child.kill('SIGKILL');
      await once(child, 'exit');

      const { cogitator, backend } = mockCogitator({ content: 'not needed: the draft is in the checkpoint' });
      const { manager, approvalStore } = createDurableRuntime(cogitator, stateDir);
      try {
        const recovered = await manager.recoverRuns({ approvalStore });
        expect(recovered.resumed).toHaveLength(1);

        const [request] = await approvalStore.getPendingRequests();
        await approvalStore.submitResponse({
          requestId: request.id,
          decision: true,
          respondedBy: 'test',
          respondedAt: Date.now(),
        });

        await vi.waitFor(
          async () => expect((await manager.getStatus(recovered.resumed[0]))?.status).toBe('completed'),
          { timeout: 15_000, interval: 100 }
        );
        expect(readFileSync(join(dir, 'hello-world.md'), 'utf8')).toContain('A post.');
        expect(backend.getCallCount()).toBe(0);
      } finally {
        manager.dispose();
        await cogitator.close();
      }
    }, 30_000);
  });
`;

export const durableFeature: FeatureModule = {
  id: 'feature:durable',
  applies: (spec) => hasFeature(spec, 'durable'),
  apply(project) {
    project
      .file('src/workflows/publish.ts', PUBLISH_WORKFLOW_TS)
      .file('src/durable.ts', DURABLE_RUNTIME_TS)
      .file('src/approve.ts', APPROVE_TS)
      .file('tests/publish.test.ts', PUBLISH_TEST_TS)
      .file('tests/fixtures/start-publish.ts', START_PUBLISH_FIXTURE_TS)
      .register({
        kind: 'workflows',
        name: 'publish',
        from: './workflows/publish.js',
        binding: 'publishWorkflow',
      })
      .ignore('out/');
    if (project.spec.app === 'script') {
      project.script('approve', 'tsx --env-file-if-exists=.env src/approve.ts');
    }
  },
  finalize(project) {
    const { spec } = project;
    const pm = spec.packageManager;
    if (spec.app === 'script' && primaryTarget(spec) === 'workflow') {
      project.file('src/index.ts', durableEntry(project));
    }
    project.section(
      'Durable workflow',
      code`
        \`src/workflows/publish.ts\` is a saga: \`draft\` writes a post, \`review\` waits for a person to approve it, \`publish\` writes it to \`out/\` and \`announce\` adds it to the changelog. If \`announce\` fails, the compensation of \`publish\` deletes the post again (try \`FAIL_ANNOUNCE=1\`). \`src/durable.ts\` keeps runs, checkpoints and approvals under \`.cogitator/workflows/\`, so a run waiting for approval survives a restart: \`manager.recoverRuns()\` picks it up. Start a run with \`${runScript(pm, 'dev', '"your topic"')}\` and answer it from another terminal with \`${runScript(pm, 'approve')}\`.
      `
    );
  },
};

const TEAM_SWARM_TS = code`
  import type { SwarmConfig } from '@cogitator-ai/swarms';
  import { researcher } from '../agents/researcher.js';
  import { reviewer } from '../agents/reviewer.js';
  import { writer } from '../agents/writer.js';

  /** A supervisor that delegates to a researcher and a writer and checks their work. */
  export const team: SwarmConfig = {
    name: 'team',
    strategy: 'hierarchical',
    supervisor: reviewer,
    workers: [researcher, writer],
    hierarchical: { visibility: 'full', workerCommunication: true },
    resources: { maxConcurrency: 2, timeout: 300_000 },
  };
`;

const SWARM_TEST_TS = code`
  import { Swarm } from '@cogitator-ai/swarms';
  import { describe, expect, it } from 'vitest';
  import { swarms } from '../src/cogitator.js';
  import { mockCogitator } from './helpers.js';

  describe('team swarm', () => {
    it('answers through its supervisor', async () => {
      const { cogitator } = mockCogitator({ content: 'The final article.' });
      const team = new Swarm(cogitator, swarms.team);
      try {
        const result = await team.run({ input: 'Write about testing.' });
        expect(result.output).toContain('The final article.');
      } finally {
        await team.close();
        await cogitator.close();
      }
    });
  });
`;

function swarmEntry(project: ProjectBuilder): string {
  return code`
    import { createInterface } from 'node:readline/promises';
    import { styleText } from 'node:util';
    import { Swarm } from '@cogitator-ai/swarms';
    import { cogitator, swarms } from './cogitator.js';
    import { loadEnv } from './env.js';
    ${startupImports(project)}

    async function taskFromUser(): Promise<string> {
      const fromArgs = process.argv.slice(2).join(' ').trim();
      if (fromArgs) return fromArgs;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question('Task for the team: ')).trim();
      } finally {
        rl.close();
      }
    }

    async function main(): Promise<void> {
      loadEnv();
      ${startupStatements(project)}
      const input = await taskFromUser();
      if (!input) throw new Error('Give the team a task');

      const team = new Swarm(cogitator, swarms.team);
      try {
        const result = await team.run({
          input,
          onAgentStart: (name) => console.error(styleText('dim', \`> \${name}\`)),
          onAgentComplete: (name, run) =>
            console.error(styleText('dim', \`  \${name} done, \${run.usage.totalTokens} tokens\`)),
        });
        console.log(result.output);
      } finally {
        await team.close();
      }
    }

    main()
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      })
      .finally(() => cogitator.close());
  `;
}

export const swarmsFeature: FeatureModule = {
  id: 'feature:swarms',
  applies: (spec) => hasFeature(spec, 'swarms'),
  apply(project) {
    addTeamAgents(project);
    project
      .dependency('@cogitator-ai/swarms', cogitatorVersion('@cogitator-ai/swarms'))
      .file('src/agents/reviewer.ts', REVIEWER_TS)
      .file('src/swarms/team.ts', TEAM_SWARM_TS)
      .file('tests/team.test.ts', SWARM_TEST_TS)
      .register({
        kind: 'agents',
        name: 'reviewer',
        from: './agents/reviewer.js',
        binding: 'reviewer',
      })
      .register({ kind: 'swarms', name: 'team', from: './swarms/team.js', binding: 'team' });
  },
  finalize(project) {
    const { spec } = project;
    if (spec.app === 'script' && primaryTarget(spec) === 'swarm') {
      project.file('src/index.ts', swarmEntry(project));
    }
    project.section(
      'Swarm',
      code`
        \`src/swarms/team.ts\` configures a hierarchical swarm: the \`reviewer\` supervises the \`researcher\` and the \`writer\` and delegates to them with tools. \`new Swarm(cogitator, swarms.team)\` runs it; other strategies (\`round-robin\`, \`consensus\`, \`debate\`, \`auction\`, \`pipeline\`, \`negotiation\`) take the same agents.
      `
    );
  },
};
