import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type {
  CogitatorConfig,
  RunMiddleware,
  RunOptions,
  Tool,
  ToolCall,
  ToolSchema,
} from '@cogitator-ai/core';
import { errorText, posixPath } from './files';
import type { RunCapture } from './graders';
import { expectViolation, MockAbortError, renderMock } from './mocks';
import { isRecord } from './schema';
import { claudeNameOf, grantCovers, isGranted, WORKSPACE_TOOLS, type ToolGrant } from './tools';
import { parseTranscript, type TranscriptEntry, type TranscriptToolCall } from './transcript';
import type {
  PluginEvalAbort,
  PluginEvalArm,
  PluginEvalCase,
  PluginEvalMockCall,
  PluginEvalMockTool,
  PluginEvalOptions,
  PluginEvalToolCall,
} from './types';

type Core = typeof import('@cogitator-ai/core');

/** Longest a scaffold script may run */
const SCAFFOLD_TIMEOUT_MS = 120_000;

const BASE_INSTRUCTIONS = [
  'You are an AI agent working on a request of the user in a workspace of your own.',
  'Use the tools you have to do the task well, then answer the user with the result.',
].join('\n');

/** The subagent a granted `Agent` tool reaches in both arms, as Claude Code's built-in one */
const GENERAL_PURPOSE = {
  description:
    'General-purpose agent for researching questions, searching files and doing multi-step tasks. Use it when a task would take many steps and you only need its result.',
  prompt:
    'You do a task another agent handed you, with the tools you have. Work until it is done, then answer with a concise report of what you found or changed: the other agent reads only your final answer.',
};

/** How one run goes: the case, its arm and what the run may use */
export interface RunSpec {
  core: Core;
  case: PluginEvalCase;
  arm: PluginEvalArm;
  llm: CogitatorConfig['llm'];
  model: string | undefined;
  grants: readonly ToolGrant[];
  /** The MCP servers each plugin of the case declares, by plugin name */
  pluginServers: ReadonlyMap<string, ReadonlySet<string>>;
  scaffold: boolean;
  exec: PluginEvalOptions['exec'];
  keepTemp: boolean;
  signal: AbortSignal;
}

/** How a run ended and what it left for its graders */
export interface RunOutcome {
  /** What the graders read, absent when the run is not graded */
  capture?: RunCapture;
  error: string | null;
  apiError?: boolean;
  authFailed?: boolean;
  interrupted?: boolean;
  aborted?: PluginEvalAbort;
  costUsd: number;
  durationSeconds: number;
  tempDir?: string;
  /** Removes the run's temporary directory unless it is kept */
  cleanup(): void;
}

/** Whether `server` is declared by a plugin loaded in this arm */
function declaredBy(spec: RunSpec, server: string): string | undefined {
  if (spec.arm !== 'with') return undefined;
  for (const [plugin, servers] of spec.pluginServers) if (servers.has(server)) return plugin;
  return undefined;
}

function mcpNamePart(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** The tool name of a mocked MCP tool: `mcp__plugin_<plugin>_<server>__<tool>` for a plugin's server */
export function mockToolName(plugin: string | undefined, server: string, tool: string): string {
  const serverPart = plugin === undefined ? server : `plugin_${plugin}_${server}`;
  return `mcp__${mcpNamePart(serverPart)}__${mcpNamePart(tool)}`;
}

function listFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(posixPath(relative(root, full)));
    }
  };
  if (existsSync(root)) walk(root);
  return found.sort();
}

function scaffoldEnv(home: string, tmp: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: tmp,
    TERM: 'dumb',
    LANG: process.env.LANG ?? 'C.UTF-8',
  };
}

/** Runs the scaffold script in the empty workspace, the reason it failed or undefined */
function runScaffold(
  script: string,
  cwd: string,
  home: string,
  tmp: string
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('bash', [script], {
      cwd,
      env: scaffoldEnv(home, tmp),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SCAFFOLD_TIMEOUT_MS);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve(`scaffold failed: ${error.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) resolve(`scaffold failed: it ran longer than ${SCAFFOLD_TIMEOUT_MS / 1000}s`);
      else if (code !== 0) {
        const tail = stderr.trim();
        resolve(`scaffold failed: exit ${code}${tail === '' ? '' : `: ${tail}`}`);
      } else resolve(undefined);
    });
  });
}

/** The tool names of a Claude Code transcript's calls, as the agent's tools are named */
const COGITATOR_NAME_OF: Readonly<Record<string, string>> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  Glob: 'glob',
  Grep: 'grep',
  LS: 'list_files',
  Bash: 'run_command',
  Skill: 'use_skill',
  TodoWrite: 'write_todos',
  Agent: 'agent',
  Task: 'agent',
  WebFetch: 'http_request',
  WebSearch: 'web_search',
};

/** A transcript to resume as the run's history */
type HistoryMessage = NonNullable<RunOptions['history']>[number];

function historyOf(file: string): HistoryMessage[] {
  const parsed = parseTranscript(readFileSync(file, 'utf8'));
  if ('error' in parsed) throw new Error(`history_file: ${parsed.error}`);
  return parsed.map((entry): HistoryMessage => {
    switch (entry.role) {
      case 'user':
        return { role: 'user', content: entry.text };
      case 'assistant':
        return entry.toolCalls.length === 0
          ? { role: 'assistant', content: entry.text }
          : {
              role: 'assistant',
              content: entry.text,
              toolCalls: entry.toolCalls.map((call) => ({
                id: call.id,
                name: COGITATOR_NAME_OF[call.name] ?? call.name,
                arguments: call.input,
              })),
            };
      case 'tool':
        return {
          role: 'tool',
          content: entry.content,
          toolCallId: entry.toolUseId,
          name: COGITATOR_NAME_OF[entry.name] ?? entry.name,
        };
    }
  });
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface ErrorFacts {
  api: boolean;
  auth: boolean;
}

/** Whether `error` (or an error it wraps) is a model provider's, and whether it rejected the key */
function providerError(error: unknown): ErrorFacts {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && isRecord(current); depth++) {
    const code = typeof current.code === 'string' ? current.code : '';
    const details = isRecord(current.details) ? current.details : {};
    const status = typeof details.statusCode === 'number' ? details.statusCode : undefined;
    const kind = details.kind;
    if (current.name === 'LLMError' || code.startsWith('LLM_')) {
      return {
        api: true,
        auth:
          kind === 'authentication' || kind === 'permission' || status === 401 || status === 403,
      };
    }
    current = current.cause;
  }
  return { api: false, auth: false };
}

/** The pieces of a run the recorder collects for the graders */
interface Recording {
  entries: TranscriptEntry[];
  toolCalls: PluginEvalToolCall[];
  mockCalls: PluginEvalMockCall[];
  lastMessage: string;
}

/**
 * The middleware of the eval's runtime, so every run gets it, the agents the agent under test
 * delegates to included: it hides the tools the run was not granted from the model, refuses calls
 * to them and lets granted calls run without asking, and records the tool calls under Claude
 * Code's names for the graders (a delegated agent's with its name in `agent`), and the main run's
 * messages for the transcript
 */
function recorder(
  core: Core,
  grants: readonly ToolGrant[],
  mocked: ReadonlySet<string>,
  place: Parameters<Core['ruleAllowsCall']>[3] & { projectRoot: string },
  recording: Recording
): RunMiddleware {
  const root = place.projectRoot;
  const offered = (name: string) => mocked.has(name) || isGranted(grants, name);
  const pending = new Map<string, TranscriptToolCall>();
  return {
    name: 'plugin-eval-grants',
    wrapModelCall: (call, next) => {
      const tools = call.request.tools?.filter((tool: ToolSchema) => offered(tool.name));
      return next({ ...call, request: { ...call.request, ...(tools && { tools }) } });
    },
    afterModel: (event, context) => {
      if (context.parentRunId !== undefined) return;
      const calls = (event.response.toolCalls ?? []).map((call: ToolCall) => {
        const recorded: TranscriptToolCall = {
          id: call.id,
          name: claudeNameOf(call.name),
          input: call.arguments,
        };
        pending.set(call.id, recorded);
        return recorded;
      });
      recording.entries.push({ role: 'assistant', text: event.response.content, toolCalls: calls });
      if (event.response.content.trim() !== '') recording.lastMessage = event.response.content;
    },
    beforeToolCall: async (event, context) => {
      const { tool, toolCall } = event;
      if (!mocked.has(tool.name)) {
        const matching = grants.filter((grant) => grantCovers(grant.tool, tool.name));
        if (matching.length === 0) {
          return { decision: 'deny', reason: `${tool.name} is not granted in this eval run` };
        }
        if (!matching.some((grant) => grant.specifier === undefined)) {
          let allowed = false;
          for (const grant of matching) {
            if (await core.ruleAllowsCall(grant.rule, tool, toolCall.arguments, place)) {
              allowed = true;
              break;
            }
          }
          if (!allowed) {
            return {
              decision: 'deny',
              reason: `this call is outside what the eval run grants: ${matching.map((g) => g.rule).join(', ')}`,
            };
          }
        }
      }
      const input = core.claudeToolOf(tool)?.input(toolCall.arguments, root) ?? toolCall.arguments;
      const name = tool.mcp ? tool.name : claudeNameOf(tool.name);
      const delegated = context.parentRunId !== undefined;
      recording.toolCalls.push({
        id: toolCall.id,
        name,
        tool: tool.name,
        input,
        ...(delegated && { agent: context.agentName }),
      });
      const entry = delegated ? undefined : pending.get(toolCall.id);
      if (entry) entry.input = input;
      return { decision: 'allow' };
    },
    wrapToolCall: async (call, next, context) => {
      const result = await next(call);
      if (context.parentRunId === undefined) {
        recording.entries.push({
          role: 'tool',
          toolUseId: call.toolCall.id,
          name: claudeNameOf(call.tool.name),
          content: result.error ?? resultText(result.result),
          isError: result.error !== undefined,
        });
      }
      return result;
    },
  };
}

const MOCK_PARAMETERS = z.record(z.string(), z.unknown());

function mockTool(
  core: Core,
  mock: PluginEvalMockTool,
  name: string,
  origin: string,
  record: (call: PluginEvalMockCall) => void,
  abort: (abort: PluginEvalAbort) => never
): Tool {
  const description = mock.description ?? `The ${mock.tool} tool of the ${mock.server} MCP server`;
  const parameters = mock.inputSchema
    ? core.toToolParameters({ ...mock.inputSchema, type: 'object' })
    : { type: 'object' as const, properties: {}, additionalProperties: true };
  return {
    name,
    description,
    parameters: MOCK_PARAMETERS,
    mcp: { server: origin, tool: mock.tool },
    execute: async (input: Record<string, unknown>) => {
      const violation = expectViolation(mock, input);
      if (violation)
        abort({ server: mock.server, tool: mock.tool, reason: `expect: ${violation}` });
      let output: string;
      try {
        output = renderMock(mock, input);
      } catch (error) {
        record({
          server: mock.server,
          tool: mock.tool,
          input,
          output: errorText(error),
          error: true,
        });
        throw error;
      }
      record({ server: mock.server, tool: mock.tool, input, output, error: mock.error });
      if (mock.error) throw new Error(output);
      return output;
    },
    toJSON: (): ToolSchema => ({ name, description, parameters }),
  };
}

function instructionsOf(
  core: Core,
  spec: RunSpec,
  workspaceTools: readonly (typeof WORKSPACE_TOOLS)[number][],
  todos: boolean,
  subagents: boolean
): string {
  const parts = [
    BASE_INSTRUCTIONS,
    core.harnessPrompt({ workspaceTools, todos, subagents, permissions: true }),
  ];
  const added = spec.case.context.addDirs;
  if (added.length > 0) {
    parts.push(
      `Reference directories of the workspace, read-only: ${added.map((dir) => `${dir}/`).join(', ')}`
    );
  }
  if (spec.case.appendSystemPrompt !== undefined) parts.push(spec.case.appendSystemPrompt);
  return parts.filter((part) => part.trim() !== '').join('\n\n');
}

/**
 * Runs the case once in a fresh temporary workspace: the scaffold, the read-only fixture
 * directories, an agent with the granted tools and, in the with-arm, the case's plugins. The run
 * never stops to ask: what is not granted is not given
 */
export async function executeRun(spec: RunSpec): Promise<RunOutcome> {
  const { core, case: evalCase } = spec;
  const started = Date.now();
  const tempDir = mkdtempSync(join(tmpdir(), 'cogitator-plugin-eval-'));
  const root = join(tempDir, 'workspace');
  const home = join(tempDir, 'home');
  const tmp = join(tempDir, 'tmp');
  for (const dir of [root, home, tmp]) mkdirSync(dir, { recursive: true });
  const cleanup = () => {
    if (!spec.keepTemp) rmSync(tempDir, { recursive: true, force: true });
  };
  const seconds = () => (Date.now() - started) / 1000;
  const ended = (fields: Partial<RunOutcome> & { error: string | null }): RunOutcome => ({
    costUsd: 0,
    durationSeconds: seconds(),
    ...(spec.keepTemp && { tempDir }),
    cleanup,
    ...fields,
  });

  if (evalCase.context.scaffoldScript && spec.scaffold) {
    const failed = await runScaffold(evalCase.context.scaffoldScript, root, home, tmp);
    if (failed) return ended({ error: failed });
  }
  for (const dir of evalCase.context.addDirs) {
    const into = join(root, dir);
    if (existsSync(into)) {
      return ended({ error: `context.add_dirs ${dir} collides with a path the scaffold created` });
    }
    cpSync(join(evalCase.dir, dir), into, { recursive: true });
  }
  const before = new Set(listFiles(root));

  const recording: Recording = {
    entries: [{ role: 'user', text: evalCase.prompt }],
    toolCalls: [],
    mockCalls: [],
    lastMessage: '',
  };
  const controller = new AbortController();
  let aborted: PluginEvalAbort | undefined;
  const abort = (reason: PluginEvalAbort): never => {
    aborted ??= reason;
    const error = new MockAbortError(reason);
    controller.abort(error);
    throw error;
  };
  const record = (call: PluginEvalMockCall) => recording.mockCalls.push(call);

  const mockedNames = new Set<string>();
  const ownMocks: Tool[] = [];
  const pluginMocks = new Map<string, PluginEvalMockTool[]>();
  for (const [server, tools] of Object.entries(evalCase.mocks)) {
    const plugin = declaredBy(spec, server);
    if (plugin !== undefined) {
      pluginMocks.set(`plugin:${plugin}:${server}`, tools);
      for (const mock of tools) mockedNames.add(mockToolName(plugin, server, mock.tool));
      continue;
    }
    if ([...spec.pluginServers.values()].some((servers) => servers.has(server))) continue;
    for (const mock of tools) {
      const name = mockToolName(undefined, server, mock.tool);
      mockedNames.add(name);
      ownMocks.push(mockTool(core, mock, name, server, record, abort));
    }
  }

  const workspace = new core.LocalWorkspace({
    root,
    exec: { ...spec.exec, env: { ...evalCase.env, HOME: home, TMPDIR: tmp } },
  });
  const workspaceNames = WORKSPACE_TOOLS.filter((name) => isGranted(spec.grants, name));
  const todos = isGranted(spec.grants, 'write_todos');
  const subagents = isGranted(spec.grants, 'agent');
  const tools: Tool[] = [
    ...(workspaceNames.length > 0
      ? core.workspaceTools(workspace, { tools: workspaceNames, requireApproval: () => false })
      : []),
    ...(isGranted(spec.grants, 'http_request') ? [core.httpRequest] : []),
    ...(isGranted(spec.grants, 'web_search') ? [core.webSearch] : []),
    ...ownMocks,
  ];
  const agent = new core.Agent({
    name: 'plugin-eval',
    ...(spec.model !== undefined && { model: spec.model }),
    instructions: instructionsOf(core, spec, workspaceNames, todos, subagents),
    tools,
    workspace,
    ...(todos && { todos: true }),
    maxIterations: evalCase.maxTurns,
    onIterationLimit: 'stop',
  });
  const connector: NonNullable<
    NonNullable<CogitatorConfig['experimental_plugins']>['mcp']
  > = async (servers) => ({
    tools: servers.flatMap(({ name }) => {
      const [, plugin = '', server = ''] = /^plugin:([^:]+):(.+)$/.exec(name) ?? [];
      return (pluginMocks.get(name) ?? []).map((mock) =>
        mockTool(core, mock, mockToolName(plugin, server, mock.tool), name, record, abort)
      );
    }),
    close: async () => undefined,
  });
  const cogitator = new core.Cogitator({
    llm: spec.llm,
    ...(spec.arm === 'with' && {
      experimental_plugins: {
        dirs: evalCase.plugins,
        installed: false,
        settings: false,
        mcp: connector,
      },
    }),
    ...(subagents && {
      subagents: { files: false, agents: { 'general-purpose': GENERAL_PURPOSE } },
    }),
    middleware: [
      recorder(core, spec.grants, mockedNames, { workspace, projectRoot: root }, recording),
    ],
  });

  const timeoutMs = evalCase.timeoutSeconds * 1000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`timed out after ${evalCase.timeoutSeconds}s`));
  }, timeoutMs);
  const onInterrupt = () => controller.abort(new Error('interrupted'));
  if (spec.signal.aborted) onInterrupt();
  else spec.signal.addEventListener('abort', onInterrupt, { once: true });

  let costUsd = 0;
  let error: string | null = null;
  let facts: ErrorFacts = { api: false, auth: false };
  try {
    const deny = evalCase.context.addDirs.flatMap((dir) => [`Edit(${dir}/**)`, `Write(${dir}/**)`]);
    const result = await cogitator.run(agent, {
      input: evalCase.prompt,
      signal: controller.signal,
      useMemory: false,
      saveHistory: false,
      permissions: { mode: 'dontAsk', ...(deny.length > 0 && { deny }) },
      ...(evalCase.context.historyFile && { history: historyOf(evalCase.context.historyFile) }),
      onRunError: (_error, _runId, usage) => {
        costUsd = usage?.cost ?? costUsd;
      },
    });
    costUsd = result.usage.cost;
    if (result.output.trim() !== '') recording.lastMessage = result.output;
    if (result.iterationLimitReached) error = `reached max_turns (${evalCase.maxTurns})`;
    else if (result.status === 'paused') error = 'the run paused waiting for an approval';
  } catch (thrown) {
    if (aborted === undefined) {
      if (timedOut) error = `timed out after ${evalCase.timeoutSeconds}s`;
      else if (spec.signal.aborted) error = 'interrupted';
      else {
        facts = providerError(thrown);
        error = facts.api ? `API error: ${errorText(thrown)}` : errorText(thrown);
      }
    }
  } finally {
    clearTimeout(timer);
    spec.signal.removeEventListener('abort', onInterrupt);
    await cogitator.close().catch(() => undefined);
    await workspace.dispose().catch(() => undefined);
  }

  if (aborted) return ended({ error: null, aborted, costUsd });
  if (error === 'interrupted') return ended({ error, interrupted: true, costUsd });
  if (facts.api) {
    return ended({ error, apiError: true, ...(facts.auth && { authFailed: true }), costUsd });
  }
  const filesCreated = listFiles(root).filter((path) => !before.has(path));
  return ended({
    error,
    costUsd,
    capture: {
      prompt: evalCase.prompt,
      lastMessage: recording.lastMessage,
      entries: recording.entries,
      toolCalls: recording.toolCalls,
      mockCalls: recording.mockCalls,
      filesCreated,
      workspaceRoot: root,
      caseDir: evalCase.dir,
    },
  });
}
