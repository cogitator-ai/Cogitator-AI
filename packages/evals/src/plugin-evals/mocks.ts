import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { errorText, isDirectory, isInside } from './files';
import {
  isRecord,
  issuesText,
  MockFrontmatterSchema,
  readMarkdown,
  ToolsListSchema,
} from './schema';
import type {
  PluginEvalAbort,
  PluginEvalExpectation,
  PluginEvalExpectType,
  PluginEvalMockTool,
} from './types';

/** Longest string value an `expect:` pattern checks: a longer one counts as a violation */
export const EXPECT_MAX_LENGTH = 4096;

const EXPECT_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'array',
  'object',
  'null',
]);

/** The mocks of one server directory: its tools, and the files that cannot be used, by file name */
interface ServerMocks {
  tools: Map<string, PluginEvalMockTool>;
  problems: Map<string, string>;
}

/** The mocks of a case, and why the servers that cannot be used cannot, by server */
export interface CaseMocks {
  mocks: Record<string, PluginEvalMockTool[]>;
  problems: Record<string, string>;
}

/**
 * The mocked tools of a case: the suite's mocks with the case's own over them, file by file.
 * A file of the case's own `mocks/` that cannot be used throws with the file and the reason, since
 * the case asked for it. A suite file that cannot be used is reported in `problems` under its
 * server, so it fails only the cases that use that server
 */
export function loadMocks(suiteDir: string | undefined, caseDir: string): CaseMocks {
  const merged = new Map<string, ServerMocks>();
  const own = join(caseDir, 'mocks');
  for (const dir of [suiteDir, own]) {
    if (dir === undefined || !isDirectory(dir)) continue;
    for (const [server, found] of readMockDir(dir)) {
      if (dir === own) {
        const [problem] = found.problems.values();
        if (problem !== undefined) throw new Error(problem);
      }
      const into = merged.get(server) ?? { tools: new Map(), problems: new Map() };
      for (const [name, tool] of found.tools) {
        into.tools.set(name, tool);
        into.problems.delete(`${name}.md`);
      }
      for (const [file, problem] of found.problems) into.problems.set(file, problem);
      merged.set(server, into);
    }
  }
  const mocks: Record<string, PluginEvalMockTool[]> = {};
  const problems: Record<string, string> = {};
  for (const [server, found] of merged) {
    if (found.problems.size > 0) {
      problems[server] = [...found.problems.values()].join(', ');
      continue;
    }
    mocks[server] = [...found.tools.values()].sort((a, b) => a.tool.localeCompare(b.tool));
  }
  return { mocks, problems };
}

function readMockDir(dir: string): Map<string, ServerMocks> {
  const servers = new Map<string, ServerMocks>();
  for (const server of readdirSync(dir).sort()) {
    const serverDir = join(dir, server);
    if (server.startsWith('.') || !isDirectory(serverDir)) continue;
    const found: ServerMocks = { tools: new Map(), problems: new Map() };
    servers.set(server, found);
    let schemas = new Map<string, ToolSchemaEntry>();
    try {
      schemas = readToolsList(serverDir);
    } catch (error) {
      found.problems.set('_tools.json', errorText(error));
    }
    for (const file of readdirSync(serverDir).sort()) {
      const path = join(serverDir, file);
      if (file === '_server.md') {
        found.problems.set(
          file,
          `${path}: _server.md agent mocks are not supported by Cogitator's plugin evals, give each tool a fixed mock file`
        );
        continue;
      }
      if (!file.endsWith('.md') || file.startsWith('_') || file.startsWith('.')) continue;
      if (!statSync(path).isFile()) continue;
      const tool = file.slice(0, -'.md'.length);
      try {
        found.tools.set(tool, readMockFile(path, server, tool, serverDir, schemas.get(tool)));
      } catch (error) {
        found.problems.set(file, errorText(error));
      }
    }
  }
  return servers;
}

interface ToolSchemaEntry {
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function readToolsList(serverDir: string): Map<string, ToolSchemaEntry> {
  const path = join(serverDir, '_tools.json');
  const found = new Map<string, ToolSchemaEntry>();
  if (!existsSync(path)) return found;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: not valid JSON (${errorText(error)})`, { cause: error });
  }
  const parsed = ToolsListSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${path}: ${issuesText(parsed.error)}`);
  const tools = Array.isArray(parsed.data) ? parsed.data : parsed.data.tools;
  for (const tool of tools) {
    const description = typeof tool.description === 'string' ? tool.description : undefined;
    const inputSchema = isRecord(tool.inputSchema) ? tool.inputSchema : undefined;
    found.set(tool.name, {
      ...(description !== undefined && { description }),
      ...(inputSchema && { inputSchema }),
    });
  }
  return found;
}

function readMockFile(
  path: string,
  server: string,
  tool: string,
  dir: string,
  schema: ToolSchemaEntry | undefined
): PluginEvalMockTool {
  const parts = readMarkdown(readFileSync(path, 'utf8'));
  if ('error' in parts) throw new Error(`${path}: ${parts.error}`);
  const parsed = MockFrontmatterSchema.safeParse(parts.fields);
  if (!parsed.success) throw new Error(`${path}: ${issuesText(parsed.error)}`);
  if (parsed.data.type === 'agent' || parsed.data.abort_when !== undefined) {
    throw new Error(
      `${path}: type: agent mocks are not supported by Cogitator's plugin evals, use a fixed mock`
    );
  }
  const expect: Record<string, PluginEvalExpectation> = {};
  for (const [field, spec] of Object.entries(parsed.data.expect ?? {})) {
    const expectation = expectationOf(spec);
    if ('error' in expectation) throw new Error(`${path}: expect.${field} ${expectation.error}`);
    expect[field] = expectation;
  }
  return {
    server,
    tool,
    body: parts.body.replace(/^\n+/, '').replace(/\s+$/, ''),
    error: parsed.data.error,
    expect,
    dir,
    ...(schema?.description !== undefined && { description: schema.description }),
    ...(schema?.inputSchema && { inputSchema: schema.inputSchema }),
  };
}

type Literal = string | number | boolean | null;

function isLiteral(value: unknown): value is Literal {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function expectationOf(spec: unknown): PluginEvalExpectation | { error: string } {
  if (Array.isArray(spec)) {
    if (spec.length === 0 || !spec.every(isLiteral)) {
      return { error: 'must list literal values (strings, numbers, booleans, null)' };
    }
    return { kind: 'oneOf', values: spec };
  }
  if (typeof spec === 'string') {
    if (EXPECT_TYPES.has(spec)) return { kind: 'type', type: spec as PluginEvalExpectType };
    const pattern = /^\/(.*)\/([a-z]*)$/s.exec(spec);
    if (pattern) {
      const [, source = '', flags = ''] = pattern;
      const problem = dialectProblem(source) ?? flagsProblem(flags);
      if (problem) return { error: `has the pattern ${spec}, which ${problem}` };
      return { kind: 'pattern', source, flags };
    }
    return { kind: 'literal', value: spec };
  }
  if (isLiteral(spec)) return { kind: 'literal', value: spec };
  return { error: 'must be a type name, a /regex/, a literal or a list of literals' };
}

function flagsProblem(flags: string): string | undefined {
  return /^[is]*$/.test(flags) ? undefined : 'uses a flag other than i and s';
}

/**
 * Why `source` is outside the pattern dialect of `expect:` (literals, `.`, escapes, classes, the
 * quantifiers `* + ? {m,n}` on one of those, an optional `^` and `$`), undefined when it is in it
 */
export function dialectProblem(source: string): string | undefined {
  let at = source.startsWith('^') ? 1 : 0;
  let end = source.length;
  if (end > at && source.endsWith('$') && !escapedAt(source, end - 1)) end--;
  while (at < end) {
    const char = source[at];
    if (char === '(' || char === ')') return 'has a group, which the dialect does not allow';
    if (char === '|') return 'has an alternation, write a list of literals instead';
    if (char === '^' || char === '$') return 'has an anchor that is not at its start or end';
    if (char === '*' || char === '+' || char === '?' || char === '{') {
      return 'has a quantifier with nothing to repeat';
    }
    if (char === '\\') {
      const next = source[at + 1];
      if (next === undefined || at + 1 >= end) return 'ends with a lone backslash';
      if (/[1-9k]/.test(next)) return 'has a backreference, which the dialect does not allow';
      at += 2;
    } else if (char === '[') {
      const close = classEnd(source, at, end);
      if (close === -1) return 'has an unclosed character class';
      at = close + 1;
    } else at++;
    const quantified = quantifierEnd(source, at, end);
    if (quantified === -1) return 'has a malformed {m,n} quantifier';
    if (quantified !== at && quantified < end && source[quantified] === '?') {
      return 'has a lazy quantifier, which the dialect does not allow';
    }
    at = quantified;
  }
  try {
    new RegExp(source);
  } catch (error) {
    return `is not a valid regular expression: ${errorText(error)}`;
  }
  return undefined;
}

function escapedAt(source: string, index: number): boolean {
  let slashes = 0;
  for (let at = index - 1; at >= 0 && source[at] === '\\'; at--) slashes++;
  return slashes % 2 === 1;
}

function classEnd(source: string, open: number, end: number): number {
  let at = open + 1;
  if (source[at] === '^') at++;
  if (source[at] === ']') at++;
  while (at < end) {
    if (source[at] === '\\') at += 2;
    else if (source[at] === ']') return at;
    else at++;
  }
  return -1;
}

/** Where a quantifier after an atom ends (`at` itself without one), -1 for a broken `{m,n}` */
function quantifierEnd(source: string, at: number, end: number): number {
  const char = source[at];
  if (at >= end) return at;
  if (char === '*' || char === '+' || char === '?') return at + 1;
  if (char !== '{') return at;
  const match = /^\{\d+(?:,\d*)?\}/.exec(source.slice(at, end));
  return match ? at + match[0].length : -1;
}

/** Why `input` violates the mock's `expect:` checks, undefined when it passes them */
export function expectViolation(
  mock: PluginEvalMockTool,
  input: Record<string, unknown>
): string | undefined {
  for (const [field, expectation] of Object.entries(mock.expect)) {
    const found = valueAt(input, field);
    if (!found.present) return `${field} is missing`;
    const problem = violation(expectation, found.value);
    if (problem) return `${field} ${problem}`;
  }
  return undefined;
}

function violation(expectation: PluginEvalExpectation, value: unknown): string | undefined {
  switch (expectation.kind) {
    case 'type':
      return typeOf(value) === expectation.type ? undefined : `is not a ${expectation.type}`;
    case 'pattern': {
      if (typeof value !== 'string') return 'is not a string';
      if (value.length > EXPECT_MAX_LENGTH) {
        return `is longer than ${EXPECT_MAX_LENGTH} characters`;
      }
      return new RegExp(expectation.source, expectation.flags).test(value)
        ? undefined
        : `does not match /${expectation.source}/${expectation.flags}`;
    }
    case 'literal':
      return value === expectation.value
        ? undefined
        : `is not ${JSON.stringify(expectation.value)}`;
    case 'oneOf':
      return isLiteral(value) && expectation.values.includes(value)
        ? undefined
        : `is not one of ${expectation.values.map((v) => JSON.stringify(v)).join(', ')}`;
  }
}

function typeOf(value: unknown): PluginEvalExpectType | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : undefined;
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'object') {
    return typeof value as PluginEvalExpectType;
  }
  return undefined;
}

function valueAt(input: unknown, path: string): { present: boolean; value?: unknown } {
  let current: unknown = input;
  for (const key of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(key)) {
      const index = Number(key);
      if (index >= current.length) return { present: false };
      current = current[index];
    } else if (isRecord(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else return { present: false };
  }
  return { present: true, value: current };
}

function textOf(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The mock's answer to `input`: its body with `{{input.<field>}}` replaced by the field and
 * `{{file:<path>}}` by the contents of a file of the server's mock directory, where `<path>` may
 * hold `{input.<field>}`
 */
export function renderMock(mock: PluginEvalMockTool, input: Record<string, unknown>): string {
  return mock.body.replace(
    /\{\{\s*([^{}]*(?:\{[^{}]*\}[^{}]*)*)\s*\}\}/g,
    (whole, inner: string) => {
      const expression = inner.trim();
      if (expression.startsWith('input.')) {
        const found = valueAt(input, expression.slice('input.'.length));
        return found.present ? textOf(found.value) : '';
      }
      if (expression.startsWith('file:')) {
        const name = expression
          .slice('file:'.length)
          .replace(/\{\s*input\.([^{}\s]+)\s*\}/g, (_match, field: string) => {
            const found = valueAt(input, field);
            return found.present ? textOf(found.value) : '';
          });
        const path = resolve(mock.dir, name);
        if (path === mock.dir || !isInside(mock.dir, path)) {
          throw new Error(`The mock fixture ${name} is outside the mock directory`);
        }
        if (!existsSync(path) || !statSync(path).isFile()) {
          throw new Error(`The mock fixture ${name} does not exist`);
        }
        return readFileSync(path, 'utf8');
      }
      return whole;
    }
  );
}

/** A mock stopping its run: the run scores 0 and reports `aborted` */
export class MockAbortError extends Error {
  constructor(readonly abort: PluginEvalAbort) {
    super(`${abort.server}/${abort.tool}: ${abort.reason}`);
    this.name = 'MockAbortError';
  }
}
