import { basename, resolve } from 'node:path';
import { BridgeError } from './errors.js';
import { findProjectRoot } from './paths.js';
import type { BridgeStore } from './store/store.js';
import { HARNESSES, type AgentRecord, type CallerIdentity } from './types.js';

/** The environment variable each harness tells its session id in. */
export const HARNESS_SESSION_ENV: ReadonlyArray<{ harness: string; variable: string }> = [
  { harness: HARNESSES.claudeCode, variable: 'CLAUDE_CODE_SESSION_ID' },
  { harness: HARNESSES.codex, variable: 'CODEX_THREAD_ID' },
];

/** Says which harness is calling when the environment names more than one session. */
export const HARNESS_ENV = 'COGITATOR_BRIDGE_HARNESS';

/** The name the bridge gave a session it started, set in that session's environment. */
export const AGENT_NAME_ENV = 'COGITATOR_BRIDGE_AGENT';

/** What a person calls the session, when the harness or its adapter tells. */
export const SESSION_NAME_ENV = 'COGITATOR_BRIDGE_SESSION_NAME';

const ALIASES: Readonly<Record<string, string>> = {
  claude: HARNESSES.claudeCode,
};

/** Asks for a fresh session in an address: `codex:new`. */
export const NEW_SESSION = 'new';

/** The shortest piece of a session id an address may name it by. */
const MIN_ID_PREFIX = 4;

/** The harness an address names: `claude` is `claude-code`, any other word is itself. */
export function harnessOfAlias(alias: string): string {
  const key = alias.trim().toLowerCase();
  return ALIASES[key] ?? key;
}

/** The short word a harness goes by in agent names: `claude-code` is `claude`. */
export function aliasOfHarness(harness: string): string {
  const alias = Object.entries(ALIASES).find(([, name]) => name === harness)?.[0];
  return alias ?? harness;
}

/** The project's folder name, made safe for an agent name: no spaces, `@` or `:`. */
export function projectLabel(project: string): string {
  const label = basename(project)
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return label || 'project';
}

/**
 * Who calls the bridge, from the environment its harness gave it: the session id of Claude Code
 * (`CLAUDE_CODE_SESSION_ID`) or Codex (`CODEX_THREAD_ID`). Undefined when the environment names
 * no session, as in a person's own shell.
 *
 * @throws BridgeError `not_registered` when the environment names sessions of several harnesses
 * (one runs inside the other) and `COGITATOR_BRIDGE_HARNESS` does not say which one is calling
 */
export function callerFromEnv(env: NodeJS.ProcessEnv, cwd: string): CallerIdentity | undefined {
  const present = HARNESS_SESSION_ENV.flatMap(({ harness, variable }) => {
    const sessionId = env[variable]?.trim();
    return sessionId ? [{ harness, variable, sessionId }] : [];
  });
  if (present.length === 0) return undefined;

  const chosen = env[HARNESS_ENV]?.trim();
  let session = present[0];
  if (chosen) {
    const harness = harnessOfAlias(chosen);
    const match = present.find((candidate) => candidate.harness === harness);
    if (!match) {
      throw new BridgeError(
        'not_registered',
        `${HARNESS_ENV} is "${chosen}", but the environment has no session id of that harness`
      );
    }
    session = match;
  } else if (present.length > 1) {
    throw new BridgeError(
      'not_registered',
      `The environment names sessions of several harnesses (${present.map((p) => p.variable).join(', ')}): ` +
        `one runs inside the other. Set ${HARNESS_ENV} to the one that is calling`,
      { harnesses: present.map((p) => p.harness) }
    );
  }

  const agentName = env[AGENT_NAME_ENV]?.trim();
  const sessionName = env[SESSION_NAME_ENV]?.trim();
  const folder = resolve(cwd);
  return {
    harness: session.harness,
    sessionId: session.sessionId,
    cwd: folder,
    project: findProjectRoot(folder),
    ...(sessionName && { sessionName }),
    ...(agentName && { agentName }),
  };
}

/** A name nobody in the book has: `codex@demo`, then `codex-2@demo`, `codex-3@demo`. */
export function allocateAgentName(store: BridgeStore, harness: string, project: string): string {
  const alias = aliasOfHarness(harness);
  const label = projectLabel(project);
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? `${alias}@${label}` : `${alias}-${index}@${label}`;
    if (!store.getAgent(name)) return name;
  }
}

/** Who an address reaches: a session in the book, or one the bridge has to start. */
export type AddressResolution =
  { kind: 'agent'; agent: AgentRecord } | { kind: 'spawn'; harness: string; sessionName?: string };

export interface ResolveAddressContext {
  /** The project of the caller: a harness word reaches the sessions of this project */
  project: string;
  /** The caller, never a candidate itself */
  caller: string;
  /** Whether the bridge can start a session of the harness */
  canSpawn: (harness: string) => boolean;
}

function describe(agent: AgentRecord): string {
  return agent.sessionName ? `${agent.name} ("${agent.sessionName}")` : agent.name;
}

function matchSession(candidates: AgentRecord[], wanted: string): AgentRecord[] {
  const needle = wanted.toLowerCase();
  const byName = candidates.filter((agent) => agent.sessionName?.toLowerCase() === needle);
  if (byName.length > 0) return byName;
  const byId = candidates.filter((agent) => agent.sessionId === wanted);
  if (byId.length > 0) return byId;
  return candidates.filter(
    (agent) =>
      agent.sessionName?.toLowerCase().startsWith(needle) === true ||
      (wanted.length >= MIN_ID_PREFIX && agent.sessionId.startsWith(wanted))
  );
}

/**
 * Finds who an address means. An address is an agent's name (`codex-2@demo`), or a harness word
 * (`codex`, `claude`) that reaches the sessions of that harness in the caller's project: the
 * only one there is, or the one named after a colon by its session name or id (`codex:reviewer`),
 * or a new one when there is none or `codex:new` asks for it.
 *
 * @throws BridgeError `unknown_agent` for a name nobody has, `ambiguous_agent` when several
 * sessions fit, `no_session` when a session would have to be started and the bridge cannot
 */
export function resolveAddress(
  store: BridgeStore,
  address: string,
  context: ResolveAddressContext
): AddressResolution {
  const text = address.trim();
  if (!text) throw new BridgeError('invalid_input', 'The address is empty');

  if (text.includes('@')) {
    const agent = store.getAgent(text);
    if (!agent || agent.status === 'gone') {
      throw new BridgeError('unknown_agent', `There is no agent ${text}`, { address: text });
    }
    if (agent.name === context.caller) {
      throw new BridgeError('invalid_input', 'An agent cannot hand a job to itself');
    }
    return { kind: 'agent', agent };
  }

  const colon = text.indexOf(':');
  const harness = harnessOfAlias(colon === -1 ? text : text.slice(0, colon));
  const wanted = colon === -1 ? undefined : text.slice(colon + 1).trim();
  if (wanted === '') {
    throw new BridgeError(
      'invalid_input',
      `The address "${text}" names no session after the colon`
    );
  }

  const candidates = store
    .listAgents({ project: context.project, harness, statuses: ['active', 'starting'] })
    .filter((agent) => agent.name !== context.caller);
  const spawn = (sessionName?: string): AddressResolution => {
    if (context.canSpawn(harness)) {
      return { kind: 'spawn', harness, ...(sessionName && { sessionName }) };
    }
    const known = candidates.map(describe);
    throw new BridgeError(
      'no_session',
      known.length > 0
        ? `No ${harness} session "${sessionName}" works in this project, and the bridge cannot start one. Sessions here: ${known.join(', ')}`
        : `No ${harness} session works in this project, and the bridge cannot start one. Open one and let it call the bridge once`,
      { harness, sessions: candidates.map((agent) => agent.name) }
    );
  };

  if (wanted?.toLowerCase() === NEW_SESSION) return spawn();
  if (wanted !== undefined) {
    const matches = matchSession(candidates, wanted);
    if (matches.length === 1) return { kind: 'agent', agent: matches[0] };
    if (matches.length === 0) return spawn(wanted);
    throw new BridgeError(
      'ambiguous_agent',
      `"${wanted}" fits several ${harness} sessions: ${matches.map(describe).join(', ')}. Use the agent's name`,
      { harness, sessions: matches.map((agent) => agent.name) }
    );
  }
  if (candidates.length === 1) return { kind: 'agent', agent: candidates[0] };
  if (candidates.length === 0) return spawn();
  throw new BridgeError(
    'ambiguous_agent',
    `Several ${harness} sessions work in this project: ${candidates.map(describe).join(', ')}. ` +
      `Name one (${text}:<session name> or its agent name), or ask for a fresh one with ${text}:${NEW_SESSION}`,
    { harness, sessions: candidates.map((agent) => agent.name) }
  );
}
