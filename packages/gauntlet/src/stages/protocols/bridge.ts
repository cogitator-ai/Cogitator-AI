import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { A2AClient, A2AServer, artifactText, isA2ATask } from '@cogitator-ai/a2a';
import { a2aHono } from '@cogitator-ai/a2a/hono';
import {
  BridgeClient,
  callerFromEnv,
  codexAdapter,
  cogitatorSessions,
  hostBridge,
  hostedAdapter,
  type RenderedLetter,
} from '@cogitator-ai/bridge';
import { bridgeAgents } from '@cogitator-ai/bridge/outward';
import { installFakeHarnesses } from '@cogitator-ai/bridge/testing';
import { Agent } from '@cogitator-ai/core';
import { MCPClient, agentTools } from '@cogitator-ai/mcp';
import { MCPServer } from '@cogitator-ai/mcp/server';
import { getRequestListener } from '@hono/node-server';
import type { StageDefinition } from '../../runner/types.js';
import { A2A, CORE, MCP, closeServer, excerpt, listen } from './shared.js';

const BRIDGE = '@cogitator-ai/bridge';

/** The agent of the runtime the bridge hosts, and the harness word its jobs are addressed to. */
const ARCHIVIST = 'archivist';

/** A record no model knows, so an answer can only come from the letter of the job. */
const RECORD = { ship: 'Halvard Reine', launched: 1907, yard: 'Brekkestø' };

const RECORD_TEXT = `The ship ${RECORD.ship} was launched in ${RECORD.launched} at the ${RECORD.yard} yard.`;

/** How long a job on the gauntlet model may take. */
const JOB_MS = 120_000;

/** What the stand-in of Codex is told to answer with. */
const CODEX_SAYS = 'The parser reads one line at a time';

interface AgentToolAnswer {
  status: string;
  output: string;
  threadId: string;
}

/** A folder with a short path: the socket of the bridge lives in it, and a socket path is short. */
function shortDir(prefix: string): string {
  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  return realpathSync(mkdtempSync(join(base, prefix)));
}

/** The first letter of a kind about a job in the inbox of a session, once it is there. */
async function mailOf(
  client: BridgeClient,
  job: number,
  kind: RenderedLetter['kind'],
  signal: AbortSignal
): Promise<RenderedLetter> {
  const deadline = Date.now() + JOB_MS;
  for (;;) {
    const found = (await client.inbox({ job, peek: true })).find((letter) => letter.kind === kind);
    if (found) return found;
    const state = (await client.job(job)).state;
    if (state === 'failed' || state === 'canceled') {
      throw new Error(
        `Job #${job} ${state}: ${(await client.job(job)).reason ?? 'no reason given'}`
      );
    }
    if (signal.aborted || Date.now() > deadline) {
      throw new Error(`No ${kind} about job #${job} within ${JOB_MS} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function mentionsRecord(text: string): boolean {
  return text.includes(String(RECORD.launched));
}

export const bridgeStage: StageDefinition = {
  id: 'bridge',
  title: 'Agent bridge',
  description:
    'A dispatcher hands jobs between a session, a stand-in of Codex and an agent of the runtime it hosts, keeps score of them, and offers the agent to the outside as an A2A service and as an MCP tool.',
  packages: [BRIDGE, CORE, A2A, MCP],
  timeoutMs: 420_000,
  async run(ctx) {
    if (process.platform === 'win32') {
      throw new Error(
        'The stand-ins of the harnesses are shell scripts: this stage needs a POSIX system'
      );
    }
    const home = shortDir('gauntlet-bridge-');
    const project = shortDir('gauntlet-bridge-project-');
    mkdirSync(join(project, '.git'));
    const fakes = installFakeHarnesses();
    ctx.onCleanup(async () => {
      await fakes.cleanup();
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    });

    const archivist = new Agent({
      name: ARCHIVIST,
      model: ctx.model,
      instructions:
        'You keep the archive of a shipyard. A message hands you a job with a record and a question. Answer the question from the record in one sentence, with the exact figures of the record.',
      maxIterations: 3,
    });
    const hostErrors: string[] = [];

    const host = await ctx.check(
      'the dispatcher starts with both kinds of agents',
      async (evidence) => {
        const host = await hostBridge({
          home,
          tickMs: 200,
          onError: (error) => hostErrors.push(error.message),
          adapters: [
            codexAdapter({
              command: join(fakes.bin, 'codex'),
              env: fakes.env(),
              logDir: join(home, 'sessions'),
              onError: (error) => hostErrors.push(error.message),
            }),
            hostedAdapter({
              harness: ARCHIVIST,
              open: cogitatorSessions({ runtime: ctx.cogitator, agent: archivist }),
              onError: (error) => hostErrors.push(error.message),
            }),
          ],
        });
        ctx.onCleanup(() => host.close());
        evidence('socket', host.paths.socket);
        return host;
      }
    );

    const session = await ctx.check('a session joins the book of the bridge', async (evidence) => {
      const caller = callerFromEnv({ CLAUDE_CODE_SESSION_ID: 'gauntlet-session' }, project);
      if (!caller) throw new Error('The environment named no session');
      const client = await BridgeClient.connect({ socketPath: host.paths.socket, caller });
      ctx.onCleanup(() => client.close());
      const status = await client.status();
      evidence('agent', client.agent?.name);
      evidence('startable', status.startable);
      for (const harness of ['codex', ARCHIVIST]) {
        if (!status.startable.includes(harness)) {
          throw new Error(`The bridge cannot start a session of ${harness}`);
        }
      }
      return client;
    });

    await ctx.check(
      'a job goes to a Codex thread and its answer comes back as the report',
      async (evidence) => {
        const { job } = await session.createJob({
          to: 'codex',
          title: 'Explain the parser',
          type: 'docs',
          body: `Say in a line how the parser reads its input.\nsay: ${CODEX_SAYS}`,
        });
        const report = await mailOf(session, job.number, 'report', ctx.signal);
        evidence('job', job.number);
        evidence('to', job.to);
        evidence('report', excerpt(report.body));
        if (report.body.trim() !== CODEX_SAYS) {
          throw new Error(`The report is not what the thread answered: ${excerpt(report.body)}`);
        }
        await session.acknowledge(report.id);
      }
    );

    await ctx.check(
      'a job goes to the agent the bridge hosts, on the gauntlet model',
      async (evidence) => {
        const { job } = await session.createJob({
          to: ARCHIVIST,
          title: 'Look the ship up',
          type: 'lookup',
          body: `${RECORD_TEXT}\n\nIn which year was the ${RECORD.ship} launched?`,
          budget: { durationMs: JOB_MS },
        });
        const report = await mailOf(session, job.number, 'report', ctx.signal);
        evidence('job', job.number);
        evidence('to', job.to);
        evidence('report', excerpt(report.body));
        if (!mentionsRecord(report.body)) {
          throw new Error(`The report does not name ${RECORD.launched}: ${excerpt(report.body)}`);
        }
        await session.acknowledge(report.id);
      }
    );

    await ctx.check(
      'the scoreboard has both jobs and says who a job would go to',
      async (evidence) => {
        const results = await session.results();
        const suggestion = await session.suggest();
        evidence(
          'results',
          results.map(
            (result) => `#${result.job} ${result.harness} ${result.type} ${result.outcome}`
          )
        );
        evidence('basis', suggestion.basis);
        evidence('reason', suggestion.reason);
        for (const harness of ['codex', ARCHIVIST]) {
          if (
            !results.some((result) => result.harness === harness && result.state === 'completed')
          ) {
            throw new Error(`The scoreboard has no finished job of ${harness}`);
          }
          if (!suggestion.candidates.some((candidate) => candidate.harness === harness)) {
            throw new Error(`${harness} is no candidate for a job`);
          }
        }
      }
    );

    const outward = await ctx.check(
      'the bridge offers its agent to the outside',
      async (evidence) => {
        const outward = await bridgeAgents({
          socketPath: host.paths.socket,
          project,
          agents: [
            {
              to: `${ARCHIVIST}:new`,
              name: ARCHIVIST,
              description: 'Answers questions about the records of the shipyard',
            },
          ],
          type: 'lookup',
          timeoutMs: JOB_MS,
        });
        ctx.onCleanup(() => outward.close());
        evidence('agents', Object.keys(outward.agents));
        return outward;
      }
    );

    await ctx.check('an A2A client hands a job over HTTP and gets the report', async (evidence) => {
      const a2a = new A2AServer({ agents: outward.agents, cogitator: outward.runtime });
      const port = await ctx.freePort();
      const server = createServer(getRequestListener(a2aHono(a2a).fetch));
      await listen(server, port);
      ctx.onCleanup(() => closeServer(server));

      const client = new A2AClient(`http://127.0.0.1:${port}`, { timeout: JOB_MS });
      const card = await client.agentCard();
      const result = await client.sendMessage({
        role: 'user',
        parts: [
          {
            kind: 'text',
            text: `${RECORD_TEXT}\n\nAt which yard was the ${RECORD.ship} launched?`,
          },
        ],
      });
      if (!isA2ATask(result)) throw new Error('Expected a task, got a direct reply');
      const text = (result.artifacts ?? []).map(artifactText).join('\n');
      evidence('card', card.name);
      evidence('state', result.status.state);
      evidence('answer', excerpt(text));
      if (result.status.state !== 'completed') {
        throw new Error(`The task ended ${result.status.state}`);
      }
      if (!text.includes(RECORD.yard)) {
        throw new Error(`The answer does not name the yard ${RECORD.yard}: ${excerpt(text)}`);
      }
    });

    await ctx.check(
      'an MCP client calls the agent as a tool and gets the report',
      async (evidence) => {
        const server = new MCPServer({
          name: 'gauntlet-bridge-agents',
          version: '1.0.0',
          transport: 'http',
          port: 0,
          host: '127.0.0.1',
        });
        server.registerTools(
          agentTools(outward.toolHost, Object.values(outward.agents)).filter(
            (tool) => tool.name === ARCHIVIST
          )
        );
        await server.start();
        ctx.onCleanup(() => server.stop());
        const client = await MCPClient.connect({
          transport: 'http',
          url: `http://127.0.0.1:${server.getPort()}/mcp`,
          timeout: 10_000,
        });
        ctx.onCleanup(() => client.close());

        const names = (await client.listToolDefinitions()).map((definition) => definition.name);
        const answer = (await client.callTool(
          ARCHIVIST,
          { task: `${RECORD_TEXT}\n\nIn which year was the ${RECORD.ship} launched?` },
          { timeout: JOB_MS }
        )) as AgentToolAnswer;
        evidence('tools', names);
        evidence('status', answer.status);
        evidence('answer', excerpt(answer.output));
        if (names.length !== 1) throw new Error(`Expected one tool, got ${names.join(', ')}`);
        if (answer.status !== 'completed' || !mentionsRecord(answer.output)) {
          throw new Error(`The tool did not answer with the record: ${excerpt(answer.output)}`);
        }
      }
    );

    await ctx.check(
      'the jobs from outside are in the journal as jobs of the door',
      async (evidence) => {
        const jobs = await session.jobs({ states: ['completed'] });
        const outside = jobs.filter((job) => job.from.startsWith('outside@'));
        evidence(
          'jobs',
          jobs.map((job) => `#${job.number} ${job.from} -> ${job.to}`)
        );
        evidence('hostErrors', hostErrors);
        if (outside.length !== 2) {
          throw new Error(`Expected two jobs from outside, found ${outside.length}`);
        }
        if (hostErrors.length > 0) throw new Error(`The host reported: ${hostErrors.join(', ')}`);
      }
    );
  },
};
