import { pnpmWorkspaceYaml } from './emit.js';
import { CodedError } from './errors.js';
import type { GeneratedFile } from './project.js';
import type { PackageManager } from './spec.js';
import { closest } from './suggest.js';
import { BUN_ENGINES, NODE_ENGINES, VERSIONS } from './versions.js';

/** An example of the Cogitator repo, as `--example` turns it into a project. Indexed at build time. */
export interface ExampleEntry {
  /** `core/basic-agent`: the category and the file name without its number. */
  name: string;
  title: string;
  /** The runnable file, relative to `examples/`. */
  entry: string;
  /** Every file the project needs, relative to `examples/`. */
  files: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  /** Environment variables the files read. */
  env: string[];
  /** What runs the example: Node through tsx, or Bun for examples that use its APIs. */
  runtime: 'node' | 'bun';
}

declare const __COGITATOR_EXAMPLES__: ExampleEntry[] | undefined;

export const EXAMPLES_REPO = { owner: 'cogitator-ai', repo: 'Cogitator-AI' } as const;

/** The examples indexed when the scaffolder was built, from the `examples/` it is released with. */
export function examples(): ExampleEntry[] {
  return typeof __COGITATOR_EXAMPLES__ === 'undefined' ? [] : __COGITATOR_EXAMPLES__;
}

/** The git tag the examples of a scaffolder version are fetched from. */
export function exampleRef(version: string): string {
  return `create-cogitator-app@${version}`;
}

/** `name#ref` as `--example` takes it. */
export function parseExampleArgument(value: string): { query: string; ref?: string } {
  const at = value.indexOf('#');
  if (at === -1) return { query: value.trim() };
  const ref = value.slice(at + 1).trim();
  return { query: value.slice(0, at).trim(), ...(ref && { ref }) };
}

/**
 * The example `query` names: `core/basic-agent`, its file `core/01-basic-agent`
 * or `core/01-basic-agent.ts`, or just `basic-agent` when only one category
 * has it. Throws with the closest names otherwise.
 */
export function findExample(
  query: string,
  index: readonly ExampleEntry[] = examples()
): ExampleEntry {
  const normalized = query.replace(/^examples\//, '').replace(/\.ts$/, '');
  const exact = index.find(
    (example) => example.name === normalized || example.entry.replace(/\.ts$/, '') === normalized
  );
  if (exact) return exact;
  const short = index.filter((example) => example.name.split('/')[1] === normalized);
  if (short.length === 1) return short[0];
  if (short.length > 1) {
    throw new CodedError(
      'AMBIGUOUS_EXAMPLE',
      `"${query}" is in more than one category: ${short.map((example) => example.name).join(', ')}`
    );
  }
  const names = index.map((example) => example.name);
  const match = closest(normalized, [...names, ...names.map((name) => name.split('/')[1])]);
  const suggestion = match
    ? ` Did you mean "${names.find((name) => name.endsWith(match)) ?? match}"?`
    : '';
  throw new CodedError(
    'UNKNOWN_EXAMPLE',
    `There is no example "${query}".${suggestion} Run with --list-examples to see them all.`
  );
}

/** Where the raw content of `examples/<path>` is at `ref`. */
export function exampleFileUrl(ref: string, path: string): string {
  const encodedRef = ref.split('/').map(encodeURIComponent).join('/').replace(/%40/g, '@');
  return `https://raw.githubusercontent.com/${EXAMPLES_REPO.owner}/${EXAMPLES_REPO.repo}/${encodedRef}/examples/${path}`;
}

/** Descriptions of the variables the examples read; anything else is described generically. */
const KNOWN_ENV: Record<string, { description: string; example?: string }> = {
  GOOGLE_API_KEY: {
    description:
      'Google AI Studio key, the default provider of the examples (free tier at https://aistudio.google.com/apikey)',
  },
  OPENAI_API_KEY: { description: 'OpenAI API key, from https://platform.openai.com/api-keys' },
  ANTHROPIC_API_KEY: {
    description: 'Anthropic API key, from https://console.anthropic.com/settings/keys',
  },
  OLLAMA_URL: { description: 'Where Ollama listens', example: 'http://localhost:11434' },
  REDIS_URL: { description: 'Redis connection URL', example: 'redis://localhost:6379' },
  DATABASE_URL: {
    description: 'Postgres connection URL',
    example: 'postgresql://cogitator:cogitator@localhost:5432/cogitator',
  },
  TG_TOKEN: { description: 'Telegram bot token, from @BotFather' },
  OWNER_TG_ID: { description: 'Your Telegram user id, the owner of the bot' },
  WEBCHAT_TOKEN: { description: 'Token WebChat clients authenticate with' },
  WEBCHAT_PORT: { description: 'Port of the WebChat server', example: '8080' },
  DEEPGRAM_API_KEY: { description: 'Deepgram API key for speech to text' },
  ELEVENLABS_API_KEY: { description: 'ElevenLabs API key for text to speech' },
};

/** Packages that compile native code on install, which pnpm and Bun run only when allowed. */
const NATIVE_BUILDS = new Set([
  'better-sqlite3',
  'esbuild',
  'protobufjs',
  'sharp',
  'onnxruntime-node',
]);

export interface ExamplePlanOptions {
  name: string;
  packageManager: PackageManager;
  version: string;
  ref: string;
  /** Values for `.env`. */
  secrets?: Record<string, string>;
}

export interface ExamplePlan {
  example: ExampleEntry;
  ref: string;
  /** Files generated around the example. */
  files: GeneratedFile[];
  /** The example's own files, fetched from GitHub, relative to `examples/`. */
  remoteFiles: string[];
  command: string;
  scripts: Record<string, string>;
}

/** Where an example file lands in the project: `src/` keeps the layout its relative imports expect. */
export function exampleTarget(path: string): string {
  return `src/${path}`;
}

function sorted(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/** The project around an example: package.json, tsconfig, .env.example, README and the rest. */
export function planExample(example: ExampleEntry, options: ExamplePlanOptions): ExamplePlan {
  const { name, packageManager: pm, version, ref } = options;
  const bun = example.runtime === 'bun';
  const entry = exampleTarget(example.entry);
  const scripts: Record<string, string> = bun
    ? { start: `bun ${entry}`, dev: `bun --watch ${entry}`, typecheck: 'tsc --noEmit' }
    : {
        start: `tsx --env-file-if-exists=.env ${entry}`,
        dev: `tsx watch --env-file-if-exists=.env ${entry}`,
        typecheck: 'tsc --noEmit',
      };
  const devDependencies = sorted({
    ...example.devDependencies,
    typescript: VERSIONS.typescript,
    ...(bun ? { '@types/bun': VERSIONS.typesBun } : { '@types/node': VERSIONS.typesNode }),
  });
  if (bun) delete devDependencies.tsx;
  const command = `npx create-cogitator-app@${version} ${name} --example ${example.name}${ref === exampleRef(version) ? '' : `#${ref}`}`;
  const native = [
    ...new Set([...Object.keys(example.dependencies), ...Object.keys(devDependencies), 'esbuild']),
  ]
    .filter((dep) => NATIVE_BUILDS.has(dep))
    .sort();

  const manifest = {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: bun ? { bun: BUN_ENGINES } : { node: NODE_ENGINES },
    scripts,
    dependencies: sorted(example.dependencies),
    devDependencies,
    ...(pm === 'bun' && { trustedDependencies: native }),
    cogitator: {
      generator: `create-cogitator-app@${version}`,
      example: { name: example.name, ref },
      command,
    },
  };

  const env = example.env.map((variable) => ({
    name: variable,
    ...(KNOWN_ENV[variable] ?? { description: 'Read by the example' }),
  }));
  const envExample = `${[
    '# Copy to .env and fill in what the example needs.',
    '',
    ...env.flatMap((variable) => [
      `# ${variable.description}`,
      `${variable.name}=${variable.example ?? ''}`,
      '',
    ]),
  ]
    .join('\n')
    .trimEnd()}\n`;

  const run = pm === 'npm' ? 'npm run' : pm;
  const readme = [
    `# ${example.title}`,
    '',
    `The \`${example.name}\` example of [Cogitator](https://github.com/${EXAMPLES_REPO.owner}/${EXAMPLES_REPO.repo}), as its own project. Its code is \`${entry}\`, from [\`examples/${example.entry}\`](https://github.com/${EXAMPLES_REPO.owner}/${EXAMPLES_REPO.repo}/blob/${ref}/examples/${example.entry}) at \`${ref}\`.`,
    '',
    '## Run it',
    '',
    '```bash',
    ...(env.length > 0 ? ['cp .env.example .env   # then fill in the keys', ''] : []),
    `${run} start`,
    '```',
    '',
    `\`${run} dev\` reruns it on change, \`${run} typecheck\` checks the types.`,
    ...(env.length > 0
      ? [
          '',
          '## Environment',
          '',
          ...env.map((variable) => `- \`${variable.name}\`: ${variable.description}`),
        ]
      : []),
    '',
    '## Learn more',
    '',
    '- [Cogitator docs](https://cogitator.app/docs)',
    `- [All examples](https://github.com/${EXAMPLES_REPO.owner}/${EXAMPLES_REPO.repo}/tree/${ref}/examples)`,
    '',
  ].join('\n');

  const tsconfig = {
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: [bun ? 'bun' : 'node'],
    },
    include: ['src'],
  };

  const secrets = Object.entries(options.secrets ?? {}).filter(([, value]) => value !== '');
  const files: GeneratedFile[] = [
    { path: 'package.json', content: JSON.stringify(manifest, null, 2) + '\n' },
    { path: 'tsconfig.json', content: JSON.stringify(tsconfig, null, 2) + '\n' },
    { path: 'README.md', content: readme },
    {
      path: '.gitignore',
      content: ['node_modules/', 'dist/', '.env', '*.log', '.DS_Store', ''].join('\n'),
    },
    ...(env.length > 0 ? [{ path: '.env.example', content: envExample }] : []),
    ...(secrets.length > 0
      ? [
          {
            path: '.env',
            content: secrets.map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
            mode: 0o600,
          },
        ]
      : []),
    ...(pm === 'pnpm'
      ? [
          {
            path: 'pnpm-workspace.yaml',
            content: pnpmWorkspaceYaml(native),
          },
        ]
      : []),
  ];

  return { example, ref, files, remoteFiles: example.files, command, scripts };
}

/** Fetches the example's own files from GitHub at the plan's ref. */
export async function fetchExampleFiles(
  plan: ExamplePlan,
  fetchImpl: typeof fetch = fetch
): Promise<GeneratedFile[]> {
  return Promise.all(
    plan.remoteFiles.map(async (path) => {
      const url = exampleFileUrl(plan.ref, path);
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      if (response.status === 404) {
        throw new CodedError(
          'HTTP_404',
          `examples/${path} is not at ${plan.ref} of ${EXAMPLES_REPO.owner}/${EXAMPLES_REPO.repo}. Pass --example ${plan.example.name}#main for the main branch.`
        );
      }
      if (!response.ok) {
        throw new CodedError(
          `HTTP_${response.status}`,
          `Could not download ${url}: HTTP ${response.status}`
        );
      }
      return { path: exampleTarget(path), content: await response.text() };
    })
  );
}
