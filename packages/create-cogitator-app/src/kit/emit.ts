import { code, tsKey, tsString, yamlString } from './code.js';
import type { ComposeService, EnvVar, ProjectBuilder, RegistryEntry } from './project.js';
import { DEFAULT_OLLAMA_URL } from './providers.js';
import { qualifiedModel, runsOnBun } from './spec.js';
import { BUN_ENGINES, NODE_ENGINES } from './versions.js';

/** Where each script goes in package.json; the rest follow alphabetically. */
const SCRIPT_ORDER = [
  'dev',
  'ask',
  'build',
  'start',
  'test',
  'typecheck',
  'lint',
  'format',
  'eval',
  'studio',
  'doctor',
];

function sortedRecord(entries: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

export function orderedScripts(scripts: Map<string, string>): Record<string, string> {
  const rank = (name: string) => {
    const index = SCRIPT_ORDER.indexOf(name);
    return index === -1 ? SCRIPT_ORDER.length : index;
  };
  return Object.fromEntries(
    [...scripts].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
  );
}

export interface PackageJsonExtras {
  /** `name@version` of the package manager, written to `packageManager`. */
  packageManagerSpec?: string;
  /** What `cogitator add` needs to extend the project later. */
  cogitator: Record<string, unknown>;
}

export function emitPackageJson(project: ProjectBuilder, extras: PackageJsonExtras): void {
  const { spec } = project;
  const bun = runsOnBun(spec);
  const native = [...project.nativeBuilds].sort();

  const pkg: Record<string, unknown> = {
    name: spec.name,
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: bun ? { bun: BUN_ENGINES } : { node: NODE_ENGINES },
    ...(extras.packageManagerSpec && { packageManager: extras.packageManagerSpec }),
    scripts: orderedScripts(project.scripts),
    dependencies: sortedRecord(project.dependencies),
    devDependencies: sortedRecord(project.devDependencies),
    ...(spec.packageManager === 'bun' && native.length > 0 && { trustedDependencies: native }),
    cogitator: extras.cogitator,
  };

  project.file('package.json', JSON.stringify(pkg, null, 2) + '\n');
}

/** pnpm runs dependency build scripts only when they are allowed, pnpm 11 fails the install otherwise. */
export function emitPnpmWorkspace(project: ProjectBuilder): void {
  if (project.spec.packageManager !== 'pnpm') return;
  const native = [...project.nativeBuilds, 'esbuild'].sort();
  project.file(
    'pnpm-workspace.yaml',
    ['allowBuilds:', ...[...new Set(native)].map((name) => `  ${name}: true`), ''].join('\n')
  );
}

function envExampleLine(variable: EnvVar): string[] {
  const value = variable.secret ? '' : (variable.example ?? '');
  const assignment = `${variable.name}=${value}`;
  return [`# ${variable.description}`, variable.required ? assignment : `# ${assignment}`];
}

export function emitEnvExample(project: ProjectBuilder): void {
  const variables = [...project.env.values()];
  const lines = ['# Copy to .env and fill in. Lines starting with # are optional.', ''];
  for (const variable of variables) lines.push(...envExampleLine(variable), '');
  project.file('.env.example', lines.join('\n').replace(/\n+$/, '\n'));
}

/** `.env` with the secrets given to the scaffolder, readable by the owner only. */
export function emitEnvFile(project: ProjectBuilder, secrets: Record<string, string>): void {
  const entries = Object.entries(secrets).filter(([, value]) => value !== '');
  if (entries.length === 0) return;
  const lines = entries.map(([name, value]) => `${name}=${formatEnvValue(value)}`);
  project.files.set('.env', { path: '.env', content: lines.join('\n') + '\n', mode: 0o600 });
}

export function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+,=-]*$/.test(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function zodFor(variable: EnvVar): string {
  return variable.required
    ? `required(${tsString(variable.name)}, ${tsString(variable.description)})`
    : 'z.string().optional()';
}

export function emitEnvModule(project: ProjectBuilder): void {
  const variables = [...project.env.values()];
  const fields = variables.map((v) => `${tsKey(v.name)}: ${zodFor(v)},`).join('\n');
  const anyRequired = variables.some((v) => v.required);
  project.file(
    'src/env.ts',
    code`
      import { z } from 'zod';

      ${
        anyRequired &&
        code`
          function required(name: string, description: string) {
            const message = \`\${name} is required: \${description}\`;
            return z.string({ error: message }).min(1, message);
          }
        `
      }

      const EnvSchema = z.object({
        ${fields || '// The project reads no environment variables yet.'}
      });

      export type Env = z.infer<typeof EnvSchema>;

      /**
       * The environment the project needs, checked at startup so a missing key fails
       * with its name and where to get it instead of as a provider error mid-run.
       */
      export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
        const parsed = EnvSchema.safeParse(source);
        if (parsed.success) return parsed.data;
        const problems = parsed.error.issues.map((issue) => \`  \${issue.path.join('.') || 'env'}: \${issue.message}\`);
        throw new Error(
          \`Missing or invalid environment variables, copy .env.example to .env and fill it in:\\n\${problems.join('\\n')}\`
        );
      }
    `
  );
}

function yamlList(items: readonly string[]): string {
  return `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;
}

function composeService(service: ComposeService): string[] {
  const lines = [`  ${service.name}:`, `    image: ${service.image}`];
  if (service.ports?.length) {
    lines.push('    ports:', ...service.ports.map((port) => `      - ${JSON.stringify(port)}`));
  }
  if (service.environment) {
    lines.push(
      '    environment:',
      ...Object.entries(service.environment).map(([k, v]) => `      ${k}: ${yamlString(v)}`)
    );
  }
  if (service.volumes?.length) {
    lines.push('    volumes:', ...service.volumes.map((volume) => `      - ${volume}`));
  }
  if (service.command) lines.push(`    command: ${yamlList(service.command)}`);
  if (service.entrypoint) lines.push(`    entrypoint: ${yamlList(service.entrypoint)}`);
  if (service.dependsOn) {
    lines.push('    depends_on:');
    for (const [name, condition] of Object.entries(service.dependsOn)) {
      lines.push(`      ${name}:`, `        condition: ${condition}`);
    }
  }
  if (service.healthcheck) {
    const h = service.healthcheck;
    lines.push(
      '    healthcheck:',
      `      test: ${yamlList(h.test)}`,
      `      interval: ${h.interval}`,
      `      timeout: ${h.timeout}`,
      `      retries: ${h.retries}`
    );
  }
  if (service.restart) lines.push(`    restart: ${JSON.stringify(service.restart)}`);
  return lines;
}

export function emitCompose(project: ProjectBuilder): void {
  if (!project.spec.compose || project.services.size === 0) return;
  const services = [...project.services.values()];
  const lines = [
    '# Services for local development: docker compose up -d',
    'services:',
    ...services.flatMap((service, i) => [...(i > 0 ? [''] : []), ...composeService(service)]),
  ];
  if (project.volumes.size > 0) {
    lines.push('', 'volumes:', ...[...project.volumes].sort().map((volume) => `  ${volume}:`));
  }
  project.file('docker-compose.yml', lines.join('\n') + '\n');
}

export function emitCogitatorYml(project: ProjectBuilder): void {
  const { spec } = project;
  const lines = [
    '# The Cogitator runtime: src/cogitator.ts loads it with loadConfig(), and',
    '# `cogitator deploy` reads it to build and ship the project. ${VAR:-default}',
    '# reads the environment, and API keys come from .env (OPENAI_API_KEY and the like).',
    '',
    'llm:',
    `  defaultProvider: ${spec.provider}`,
    `  defaultModel: ${yamlString(qualifiedModel(spec))}`,
  ];
  if (spec.provider === 'ollama') {
    lines.push(
      '  providers:',
      '    ollama:',
      `      baseUrl: \${OLLAMA_BASE_URL:-${DEFAULT_OLLAMA_URL}}`
    );
  }

  if (project.memoryYml.length > 0) {
    lines.push('', 'memory:', ...project.memoryYml.map((line) => `  ${line}`));
  }

  const deploy: string[] = [];
  if (spec.deploy !== 'none') deploy.push(`  target: ${spec.deploy}`);
  if (project.deploy.kind) deploy.push(`  kind: ${project.deploy.kind}`);
  if (project.deploy.port) deploy.push(`  port: ${project.deploy.port}`);
  if (project.deploy.healthPath) deploy.push('  health:', `    path: ${project.deploy.healthPath}`);
  const secrets = [...project.env.values()]
    .filter((v) => v.deploy ?? (v.secret && v.required))
    .map((v) => v.name);
  if (secrets.length > 0) deploy.push('  secrets:', ...secrets.map((name) => `    - ${name}`));
  if (deploy.length > 0) lines.push('', 'deploy:', ...deploy);

  project.file('cogitator.yml', lines.join('\n') + '\n');
}

function registryGroup(entries: RegistryEntry[], kind: RegistryEntry['kind']): string | false {
  const items = entries.filter((entry) => entry.kind === kind);
  if (items.length === 0) return false;
  const body = items.map((entry) =>
    entry.name === entry.binding ? `${entry.name},` : `${tsKey(entry.name)}: ${entry.binding},`
  );
  return `{\n  ${body.join('\n  ')}\n}`;
}

export function emitRegistry(project: ProjectBuilder): void {
  const entries = project.registry;
  const imports = new Map<string, string[]>();
  for (const entry of entries) {
    const bindings = imports.get(entry.from) ?? [];
    bindings.push(entry.binding);
    imports.set(entry.from, bindings);
  }
  const importLines = [...imports]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([from, bindings]) => `import { ${[...new Set(bindings)].sort().join(', ')} } from '${from}';`
    );

  const agents = registryGroup(entries, 'agents');
  const workflows = registryGroup(entries, 'workflows');
  const swarms = registryGroup(entries, 'swarms');

  project.file(
    'src/cogitator.ts',
    code`
      import { loadConfig } from '@cogitator-ai/config';
      import { Cogitator, type CogitatorConfig } from '@cogitator-ai/core';
      ${swarms && "import type { SwarmConfig } from '@cogitator-ai/swarms';"}
      ${importLines.join('\n')}

      /**
       * A runtime configured by cogitator.yml and the environment. \`overrides\` are
       * merged over that configuration: tests pass a mock model backend here.
       */
      export function createCogitator(overrides: CogitatorConfig = {}): Cogitator {
        const config = loadConfig();
        return new Cogitator({ ...config, ...overrides, llm: { ...config.llm, ...overrides.llm } });
      }

      /** The runtime the project shares. */
      export const cogitator = createCogitator();

      /**
       * The registry: every agent${workflows ? ', workflow' : ''}${swarms ? ' and swarm' : ''} of the project by name.
       * The entry points, the tests and \`cogitator dev\` all find them here.
       */
      export const agents = ${agents || '{}'};
      ${workflows && `\nexport const workflows = ${workflows};`}
      ${swarms && `\nexport const swarms = ${swarms} satisfies Record<string, SwarmConfig>;`}
    `
  );
}

export function emitToolsIndex(project: ProjectBuilder): void {
  const imports = [...project.tools]
    .sort((a, b) => a.from.localeCompare(b.from))
    .map((tool) => `import { ${tool.binding} } from '${tool.from}';`);
  project.file(
    'src/tools/index.ts',
    code`
      ${imports.join('\n')}

      /** The tools the assistant can call. Add a tool here to give it to the assistant. */
      export const tools = [${project.tools.map((tool) => (tool.spread ? `...${tool.binding}` : tool.binding)).join(', ')}];
    `
  );
}

export function emitGitignore(project: ProjectBuilder): void {
  project.file('.gitignore', [...project.gitignore].join('\n') + '\n');
}

export const AGENT_RULES_BEGIN = '<!-- BEGIN:cogitator-agent-rules -->';
export const AGENT_RULES_END = '<!-- END:cogitator-agent-rules -->';

/** The managed block of AGENTS.md: the scaffolder and `cogitator add` rewrite it, nothing else. */
export function agentRulesBlock(project: ProjectBuilder): string {
  const sections = project.agentsMd.map(
    (section) => `## ${section.title}\n\n${section.body.trim()}`
  );
  return [
    AGENT_RULES_BEGIN,
    '# This is a Cogitator project',
    '',
    'Cogitator is a TypeScript runtime for AI agents, and its APIs move faster than model training data. Before you write Cogitator code, read the docs bundled with the installed version in `node_modules/@cogitator-ai/core/docs/`, starting with `index.md`, and trust them over what you remember.',
    '',
    'Everything the project runs is registered in `src/cogitator.ts`: the runtime (configured by `cogitator.yml` and `.env`) and the agents' +
      (project.registry.some((e) => e.kind === 'workflows') ? ', workflows' : '') +
      (project.registry.some((e) => e.kind === 'swarms') ? ' and swarms' : '') +
      ' by name. Register new ones there so the entry points, the tests and `cogitator dev` find them.',
    '',
    ...sections.flatMap((section) => [section, '']),
    AGENT_RULES_END,
  ].join('\n');
}

export function emitAgentsMd(project: ProjectBuilder): void {
  const nextBlock =
    project.spec.app === 'next'
      ? [
          '<!-- BEGIN:nextjs-agent-rules -->',
          '# This is NOT the Next.js you know',
          '',
          'This version has breaking changes, so APIs, conventions and file structure may differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code, and heed deprecation notices.',
          '<!-- END:nextjs-agent-rules -->',
          '',
        ]
      : [];
  project.file(
    'AGENTS.md',
    [
      ...nextBlock,
      agentRulesBlock(project),
      '',
      '## Project notes',
      '',
      'Add what agents should know about this project here. The block above is managed by Cogitator.',
      '',
    ].join('\n')
  );
  project.file('CLAUDE.md', '@AGENTS.md\n');
}

const RELATIVE_JS_IMPORT = /(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+?)\.js\2/g;

/**
 * Next.js bundles with `moduleResolution: bundler`, which resolves relative
 * imports without an extension and does not map `./x.js` to `./x.ts`. Generated
 * code imports with `.js` for Node, so a Next.js app gets the extensions dropped.
 */
export function adaptImportsForBundler(project: ProjectBuilder): void {
  if (project.spec.app !== 'next') return;
  for (const file of project.files.values()) {
    if (!/\.tsx?$/.test(file.path)) continue;
    file.content = file.content.replace(RELATIVE_JS_IMPORT, '$1$2$3$2');
  }
}
