/**
 * The runtimes the session fixtures serve on stdio: an app-server over a `SessionHost` and an ACP
 * agent over another, each a Cogitator on the gauntlet's OpenRouter model with its threads in a
 * SQLite file, so a second process on the same file finds them again. The fixture files under
 * `fixtures/protocols/` only call these, so the code they run is typechecked with the stages.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { createAcpAgent, serveAcpStdio } from '@cogitator-ai/acp';
import { SessionHost, createAppServer, serveStdio } from '@cogitator-ai/app-server';
import {
  Agent,
  Cogitator,
  OpenAIBackend,
  createLogger,
  setLogger,
  tool,
  workspaceTools,
} from '@cogitator-ai/core';
import { z } from 'zod';
import { BACKEND, OPENROUTER_BASE_URL } from '../../llm.js';

/** What a session fixture reads from its environment. */
export interface SessionFixtureEnv {
  apiKey: string;
  /** The model of its agent, `openrouter/<vendor>/<model>`. */
  model: string;
  /** The SQLite file its threads live in. */
  database: string;
  /** A value the model cannot guess, which the fixture's tools answer with. */
  secret: string;
}

const ENV_KEYS = {
  model: 'GAUNTLET_FIXTURE_MODEL',
  database: 'GAUNTLET_FIXTURE_DB',
  secret: 'GAUNTLET_FIXTURE_SECRET',
} as const;

/** The environment a stage starts a session fixture with, on top of its own. */
export function sessionFixtureVariables(
  env: Omit<SessionFixtureEnv, 'apiKey'>
): Record<string, string> {
  return {
    [ENV_KEYS.model]: env.model,
    [ENV_KEYS.database]: env.database,
    [ENV_KEYS.secret]: env.secret,
  };
}

/** Reads the fixture's environment, failing on what the stage did not pass. */
export function readSessionFixtureEnv(env: NodeJS.ProcessEnv): SessionFixtureEnv {
  const read = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  return {
    apiKey: read('OPENROUTER_API_KEY'),
    model: read(ENV_KEYS.model),
    database: read(ENV_KEYS.database),
    secret: read(ENV_KEYS.secret),
  };
}

/** The agent of the app-server fixture. */
export const CLERK_AGENT = 'clerk';

/** The agent of the ACP fixture. */
export const SCRIBE_AGENT = 'scribe';

/** What `stamp_document` answers, unguessable so an answer naming it proves the tool ran. */
export function stampCode(secret: string): string {
  return `STAMP-${secret.slice(0, 8).toUpperCase()}`;
}

/** How long `survey_archive` takes unless its turn is interrupted. */
const SURVEY_MS = 180_000;

/** Stdout carries the protocol only: the runtime logs go to stderr. */
function logToStderr(): void {
  setLogger(
    createLogger({
      level: 'warn',
      output: (_entry, formatted) => {
        process.stderr.write(`${formatted}\n`);
      },
    })
  );
}

function fixtureCogitator(env: SessionFixtureEnv): Cogitator {
  logToStderr();
  return new Cogitator({
    llm: {
      defaultModel: env.model,
      backends: {
        [BACKEND]: new OpenAIBackend({
          apiKey: env.apiKey,
          baseUrl: OPENROUTER_BASE_URL,
          provider: BACKEND,
        }),
      },
    },
    memory: { adapter: 'sqlite', sqlite: { path: env.database } },
  });
}

function reportTo(label: string): (error: Error) => void {
  return (error) => {
    process.stderr.write(`${label}: ${error.message}\n`);
  };
}

/**
 * The app-server on stdio with one agent: `stamp_document` needs approval and `survey_archive`
 * runs for minutes unless its turn is interrupted. Resolves once the client closes its end.
 */
export async function serveAppServerFixture(env: SessionFixtureEnv): Promise<void> {
  const cogitator = fixtureCogitator(env);
  const stamp = tool({
    name: 'stamp_document',
    description:
      'Stamps an archived document with the archive stamp and returns the stamp code. Needs a person to approve.',
    parameters: z.object({ documentId: z.string().describe('Document id, e.g. DOC-100') }),
    requiresApproval: true,
    execute: async ({ documentId }) => ({ documentId, stamp: stampCode(env.secret) }),
  });
  const survey = tool({
    name: 'survey_archive',
    description: 'Surveys one wing of the archive shelf by shelf and counts its shelves.',
    parameters: z.object({ wing: z.string() }),
    execute: async ({ wing }, context) => {
      await sleep(SURVEY_MS, undefined, { signal: context.signal });
      return { wing, shelves: 112 };
    },
  });
  const clerk = new Agent({
    name: CLERK_AGENT,
    description: 'Keeps the document archive.',
    model: env.model,
    instructions:
      'You keep the document archive. Use the tool a request needs, then answer in one short sentence that repeats what the tool returned.',
    tools: [stamp, survey],
    maxIterations: 4,
  });
  const host = new SessionHost({
    cogitator,
    agents: { [CLERK_AGENT]: clerk },
    exposeErrors: true,
    serverInfo: { name: 'gauntlet-app-server', version: '1.0.0' },
  });
  try {
    await serveStdio(createAppServer(host), { onError: reportTo('app-server') });
  } finally {
    await host.close();
    await cogitator.close();
  }
}

/**
 * An ACP agent on stdio over a host of its own: its agent reads files and runs commands through
 * the workspace of the session, which the ACP client serves. Resolves once the client closes.
 */
export async function serveAcpFixture(env: SessionFixtureEnv): Promise<void> {
  const cogitator = fixtureCogitator(env);
  const scribe = new Agent({
    name: SCRIBE_AGENT,
    model: env.model,
    instructions:
      'You work in a project directory with read_file and run_command. Use exactly the tool a request names with the path or command it gives, never guess what a file or a command would show, and answer in one or two short sentences.',
    tools: workspaceTools().filter((entry) => ['read_file', 'run_command'].includes(entry.name)),
    maxIterations: 5,
  });
  const host = new SessionHost({
    cogitator,
    agents: { [SCRIBE_AGENT]: scribe },
    exposeErrors: true,
  });
  const acp = createAcpAgent({
    host,
    cogitator,
    agentInfo: { name: 'gauntlet-scribe', version: '1.0.0' },
    onError: reportTo('acp'),
  });
  try {
    await serveAcpStdio(acp);
  } finally {
    await host.close();
    await cogitator.close();
  }
}
