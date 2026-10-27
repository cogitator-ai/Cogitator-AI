import { parseDocument } from 'yaml';
import { z } from 'zod';

/** Default runs per arm, as Claude Code's `runs` */
export const DEFAULT_RUNS = 3;
/** Default turn cap of a run */
export const DEFAULT_MAX_TURNS = 10;
/** Default wall-clock cap of a run, in seconds */
export const DEFAULT_TIMEOUT_SECONDS = 300;

const ENV_KEY = /^EVAL_[A-Z0-9_]*$/;

const schemaVersion = z.union([z.literal('1.1'), z.literal(1.1)], {
  error: 'must be "1.1"',
});

const nonEmpty = z.string().trim().min(1, 'must not be empty');

const envSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String))
  .superRefine((env, context) => {
    for (const key of Object.keys(env)) {
      if (!ENV_KEY.test(key)) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'environment keys must match EVAL_[A-Z0-9_]*',
        });
      }
    }
  });

const runFields = {
  model: nonEmpty.optional(),
  max_turns: z.number().int().min(1).max(200).optional(),
  timeout_seconds: z.number().positive().max(3600).optional(),
  allowed_tools: z.array(nonEmpty).optional(),
  append_system_prompt: z.string().optional(),
  env: envSchema.optional(),
};

const caseFields = {
  name: nonEmpty.optional(),
  description: z.string().optional(),
  tags: z.array(nonEmpty).optional(),
  plugins: z.array(nonEmpty).optional(),
  runs: z.number().int().min(1).max(50).optional(),
  expected_outcome: z.string().optional(),
};

/** The frontmatter of a case's `prompt.md`: an unknown key is an error */
export const PromptFrontmatterSchema = z.strictObject({
  schema_version: schemaVersion.optional(),
  ...caseFields,
  ...runFields,
});

/** A case's `case.yaml` */
export const CaseYamlSchema = z.strictObject({
  schema_version: schemaVersion,
  ...caseFields,
  name: nonEmpty,
  execution: z.strictObject({ ...runFields, prompt: z.string().optional() }).optional(),
  context: z
    .strictObject({
      scaffold_script: nonEmpty.optional(),
      history_file: nonEmpty.optional(),
      add_dirs: z.array(nonEmpty).optional(),
    })
    .optional(),
  graders: z.array(z.record(z.string(), z.unknown())).optional(),
});

export type PromptFrontmatter = z.output<typeof PromptFrontmatterSchema>;
export type CaseYaml = z.output<typeof CaseYamlSchema>;

const regexSource = z.string().refine(
  (source) => {
    try {
      new RegExp(source);
      return true;
    } catch {
      return false;
    }
  },
  { error: 'is not a valid JavaScript regular expression (put case-insensitivity in flags: i)' }
);

const targetSchema = z.union(
  [
    z.enum(['last_message', 'trace', 'files', 'mock_calls']),
    z.strictObject({ source: z.literal('file'), path: nonEmpty }),
  ],
  { error: 'must be last_message, trace, files, mock_calls or { source: file, path: <path> }' }
);

const toolMatcher = z.union([
  nonEmpty,
  z.strictObject({ tool: nonEmpty, input_match: regexSource.optional() }),
]);

const graderBase = {
  name: nonEmpty.optional(),
  weight: z.number().positive().default(1),
  arm: z.enum(['with-only', 'both']).optional(),
};

/** A grader's options, from a `graders/*.md` frontmatter (with its body) or a `case.yaml` entry */
export const GraderSchema = z.discriminatedUnion(
  'type',
  [
    z.strictObject({
      ...graderBase,
      type: z.literal('regex'),
      pattern: regexSource,
      flags: z
        .string()
        .regex(/^[imsu]*$/, 'may only hold the flags i, m, s and u')
        .default(''),
      match: z
        .string()
        .regex(/^(?:contains|not_contains|count:\d+)$/, 'must be contains, not_contains or count:N')
        .default('contains'),
      target: targetSchema.default('last_message'),
    }),
    z.strictObject({
      ...graderBase,
      type: z.literal('tool_used'),
      tool: nonEmpty,
      input_match: regexSource.optional(),
      min: z.number().int().min(0).default(1),
      max: z.number().int().min(0).optional(),
    }),
    z.strictObject({
      ...graderBase,
      type: z.literal('tool_order'),
      before: toolMatcher,
      after: toolMatcher,
    }),
    z.strictObject({
      ...graderBase,
      type: z.literal('file_exists'),
      path: nonEmpty,
      exists: z.boolean().default(true),
    }),
    z.strictObject({
      ...graderBase,
      type: z.literal('llm'),
      criteria: nonEmpty,
      focus: targetSchema.default('last_message'),
    }),
    z.strictObject({
      ...graderBase,
      type: z.literal('baseline'),
      baseline_file: nonEmpty,
      criteria: nonEmpty,
    }),
  ],
  { error: 'type must be one of regex, tool_used, tool_order, file_exists, llm, baseline' }
);

export type GraderInput = z.output<typeof GraderSchema>;

/** The frontmatter of a mocked tool, `mocks/<server>/<tool>.md` */
export const MockFrontmatterSchema = z.strictObject({
  type: z.enum(['fixed', 'agent']).default('fixed'),
  expect: z.record(z.string(), z.unknown()).optional(),
  error: z.boolean().default(false),
  abort_when: z.string().optional(),
});

/** A server's `_tools.json`: a saved `tools/list` response, or its `tools` array */
export const ToolsListSchema = z.union([
  z.object({ tools: z.array(z.looseObject({ name: nonEmpty })) }),
  z.array(z.looseObject({ name: nonEmpty })),
]);

/** Zod issues in one line: `path: message, path: message` */
export function issuesText(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join(', ');
}

/** A Markdown file split into its YAML frontmatter (empty without one) and its body */
export interface MarkdownParts {
  fields: Record<string, unknown>;
  body: string;
}

/**
 * The frontmatter between the first two `---` lines of `text` read as a YAML mapping, and the
 * body after it. A file without frontmatter is all body
 */
export function readMarkdown(text: string): MarkdownParts | { error: string } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split('\n');
  if (lines[0]?.trimEnd() !== '---') return { fields: {}, body: source };
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---');
  if (end === -1) return { error: 'the frontmatter has no closing --- line' };
  const parsed = readYaml(lines.slice(1, end).join('\n'));
  if ('error' in parsed) return parsed;
  if (parsed.value === null || parsed.value === undefined) {
    return { fields: {}, body: lines.slice(end + 1).join('\n') };
  }
  if (!isRecord(parsed.value)) return { error: 'the frontmatter is not a YAML mapping' };
  return { fields: parsed.value, body: lines.slice(end + 1).join('\n') };
}

/** `text` read as YAML, or why it is not valid YAML */
export function readYaml(text: string): { value: unknown } | { error: string } {
  try {
    const document = parseDocument(text, { prettyErrors: false });
    const [problem] = document.errors;
    if (problem) return { error: `invalid YAML: ${problem.message}` };
    return { value: document.toJS({ maxAliasCount: 100 }) as unknown };
  } catch (error) {
    return { error: `invalid YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
