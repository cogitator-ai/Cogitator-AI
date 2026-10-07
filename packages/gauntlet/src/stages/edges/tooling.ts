import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '@cogitator-ai/config';
import { Deployer } from '@cogitator-ai/deploy';
import { startStudio, type RunRecord } from '@cogitator-ai/studio';
import type { GeneratedArtifacts } from '@cogitator-ai/types';
import {
  PRESETS,
  defaultModel,
  planProject,
  providerEnvKey,
  qualifiedModel,
  scaffold,
  type LLMProvider,
  type ProjectSpecInput,
} from 'create-cogitator-app';
import { z } from 'zod';
import type { StageContext, StageDefinition } from '../../runner/types.js';
import { excerpt, plain, runProcess } from './shared.js';
import { findInstalled, linkDependencies, vendorWorkspacePackages } from './workspace.js';

const CCA = 'create-cogitator-app';
const CLI = '@cogitator-ai/cli';
const DEPLOY = '@cogitator-ai/deploy';
const CONFIG = '@cogitator-ai/config';
const STUDIO = '@cogitator-ai/studio';

declare module '../../runner/types.js' {
  interface GauntletArtifacts {
    /** Generated projects by key. */
    edgesProjects: Record<string, string>;
  }
}

interface GauntletProject {
  key: string;
  preset: string;
  provider: LLMProvider;
  overrides?: Partial<ProjectSpecInput>;
}

const PROJECTS: readonly GauntletProject[] = [
  { key: 'basic', preset: 'basic', provider: 'ollama', overrides: { compose: false } },
  { key: 'assistant', preset: 'assistant', provider: 'ollama' },
  { key: 'memory', preset: 'memory', provider: 'anthropic', overrides: { memory: 'redis' } },
  { key: 'swarm', preset: 'swarm', provider: 'google' },
  { key: 'workflow', preset: 'workflow', provider: 'ollama' },
  { key: 'api-server', preset: 'api-server', provider: 'openai', overrides: { deploy: 'docker' } },
  { key: 'nextjs', preset: 'nextjs', provider: 'openai' },
];

/** Projects whose packages the monorepo does not install (Next.js and React in the right versions). */
const NOT_COMPILED: ReadonlySet<string> = new Set(['nextjs']);

/** The small local model the Ollama lane runs on, `GAUNTLET_OLLAMA_MODEL` to change it. */
const OLLAMA_MODEL = process.env.GAUNTLET_OLLAMA_MODEL ?? 'qwen2.5:0.5b';

/** The tsx loader the gauntlet runs with, for `node --import` in generated projects. */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

function specOf(
  project: GauntletProject,
  model = defaultModel(project.provider)
): ProjectSpecInput {
  const preset = PRESETS.find((candidate) => candidate.id === project.preset);
  if (!preset) throw new Error(`create-cogitator-app has no preset ${project.preset}`);
  return {
    name: `gauntlet-${project.key}`,
    preset: preset.id,
    ...preset.spec,
    provider: project.provider,
    model,
    packageManager: 'pnpm',
    ...project.overrides,
  };
}

/** The environment of child processes, read when they start: the gauntlet loads its .env after import. */
function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' };
}

function projectDir(ctx: StageContext, key: string): string {
  const dir = ctx.artifacts.get('edgesProjects')[key];
  if (!dir) throw new Error(`The scaffold stage produced no ${key} project`);
  return dir;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .filter((file) => !file.startsWith('node_modules'))
    .sort();
}

const PackageJson = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  type: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

async function readPackageJson(dir: string): Promise<z.infer<typeof PackageJson>> {
  return PackageJson.parse(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')));
}

/** Relative imports of the generated sources that point at no generated file. */
async function danglingImports(dir: string, files: readonly string[]): Promise<string[]> {
  const dangling: string[] = [];
  for (const file of files.filter((name) => /\.(ts|tsx)$/.test(name))) {
    const source = await readFile(join(dir, file), 'utf8');
    for (const match of source.matchAll(/from ['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(join(dir, file)), match[1] ?? '');
      const candidates = [
        target,
        target.replace(/\.js$/, '.ts'),
        target.replace(/\.js$/, '.tsx'),
        `${target}.ts`,
        `${target}.tsx`,
        join(target, 'index.ts'),
      ];
      if (!candidates.some((candidate) => existsSync(candidate))) {
        dangling.push(`${file} -> ${match[1]}`);
      }
    }
  }
  return dangling;
}

function cliEntry(): string {
  return fileURLToPath(import.meta.resolve(CLI));
}

function cli(args: readonly string[], cwd: string, ctx: StageContext, timeoutMs = 60_000) {
  return runProcess(process.execPath, [cliEntry(), ...args], {
    cwd,
    env: childEnv(),
    timeoutMs,
    signal: ctx.signal,
  });
}

/**
 * Dev tools of generated projects the monorepo pins to other majors: the compile check uses the
 * installed ones and reports the drift, the e2e matrix installs the exact versions.
 */
const ANY_VERSION: ReadonlySet<string> = new Set(['@types/node', 'typescript', '@biomejs/biome']);

/** Links a generated project's dependencies to the workspace packages and installed copies. */
async function link(
  dir: string
): Promise<{ linked: number; missing: string[]; drifted: string[] }> {
  const pkg = await readPackageJson(dir);
  const { linked, missing, drifted } = await linkDependencies(
    dir,
    { ...pkg.dependencies, ...pkg.devDependencies },
    { anyVersion: ANY_VERSION }
  );
  return { linked: linked.length, missing, drifted };
}

/** Proves create-cogitator-app generates coherent projects that compile against the workspace packages. */
const scaffoldStage: StageDefinition = {
  id: 'scaffold',
  title: 'Project scaffolding',
  description:
    'scaffold() from create-cogitator-app generates projects from its presets, the files agree with each other and with the spec, and the TypeScript projects compile against the workspace packages.',
  packages: [CCA, CONFIG],
  timeoutMs: 180_000,
  async run(ctx) {
    const generated: Record<string, string> = {};

    await ctx.check('every preset scaffolds through scaffold()', async (evidence) => {
      const outcomes = [];
      for (const project of PROJECTS) {
        const directory = join(ctx.tmpDir, `gauntlet-${project.key}`);
        const started = Date.now();
        const result = await scaffold(specOf(project), { directory, install: false, git: false });
        generated[project.key] = directory;
        outcomes.push({
          project: project.key,
          files: result.files.length,
          install: result.install.status,
          ms: Date.now() - started,
        });
      }
      evidence('projects', outcomes);
      ctx.artifacts.set('edgesProjects', generated);
    });

    await ctx.check('generated files agree with each other and the spec', async (evidence) => {
      const problems: string[] = [];
      const summary: Array<Record<string, unknown>> = [];
      for (const project of PROJECTS) {
        const spec = specOf(project);
        const plan = planProject(spec);
        const dir = projectDir(ctx, project.key);
        const files = await listFiles(dir);
        const pkg = await readPackageJson(dir);
        const say = (problem: string) => problems.push(`${project.key}: ${problem}`);

        if (pkg.name !== spec.name) say(`package.json name is ${pkg.name}`);
        if (!pkg.dependencies?.['@cogitator-ai/core']) say('no @cogitator-ai/core dependency');
        for (const script of ['dev', 'test', 'typecheck', 'dev:studio']) {
          if (!pkg.scripts?.[script]) say(`no ${script} script`);
        }
        if (pkg.type !== 'module') say('package.json is not an ES module');
        if (plan.services.length > 0 !== files.includes('docker-compose.yml')) {
          say('docker-compose.yml does not follow the services the project uses');
        }
        if (!files.includes('src/cogitator.ts')) say('no registry in src/cogitator.ts');
        if (!files.includes('AGENTS.md')) say('no AGENTS.md');

        const config = loadConfig({ configPath: join(dir, 'cogitator.yml'), skipEnv: true });
        if (config.llm?.defaultProvider !== spec.provider) {
          say(`cogitator.yml provider is ${config.llm?.defaultProvider}`);
        }
        const model = qualifiedModel({ provider: spec.provider, model: spec.model });
        if (config.llm?.defaultModel !== model)
          say(`cogitator.yml model is ${config.llm?.defaultModel}`);
        if (project.key === 'memory' && config.memory?.adapter !== 'redis') {
          say(`memory adapter is ${config.memory?.adapter}, not redis`);
        }
        const envKey = providerEnvKey(spec.provider);
        const envExample = await readFile(join(dir, '.env.example'), 'utf8');
        if (envKey && !envExample.includes(envKey)) say(`.env.example lacks ${envKey}`);
        const dangling = await danglingImports(dir, files);
        if (dangling.length > 0) say(`dangling imports ${dangling.join(', ')}`);
        const missing = plan.files.map((file) => file.path).filter((path) => !files.includes(path));
        if (missing.length > 0) say(`files of the plan not written: ${missing.join(', ')}`);

        summary.push({ project: project.key, provider: spec.provider, model, files: files.length });
      }
      evidence('projects', summary);
      evidence('problems', problems);
      if (problems.length > 0) throw new Error(problems.join('; '));
    });

    await ctx.check(
      'TypeScript projects compile against the workspace packages',
      async (evidence) => {
        const compiled = await Promise.all(
          PROJECTS.filter((project) => !NOT_COMPILED.has(project.key)).map(async (project) => {
            const dir = projectDir(ctx, project.key);
            const pkg = await readPackageJson(dir);
            const { linked, missing, drifted } = await link(dir);
            const typescript =
              findInstalled('typescript', pkg.devDependencies?.typescript ?? '*') ??
              findInstalled('typescript', '*');
            if (!typescript)
              return { project: project.key, ok: false, error: 'no typescript installed' };
            const result = await runProcess(
              process.execPath,
              [join(typescript.dir, 'bin', 'tsc'), '-p', 'tsconfig.json', '--noEmit'],
              { cwd: dir, env: childEnv(), timeoutMs: 120_000, signal: ctx.signal }
            );
            const errors = plain(result.stdout)
              .split('\n')
              .filter((line) => line.includes('error TS'));
            return {
              project: project.key,
              ok: result.code === 0,
              typescript: typescript.version,
              linked,
              ...(missing.length > 0 ? { missing } : {}),
              ...(drifted.length > 0 ? { drifted } : {}),
              ...(errors.length > 0
                ? { errors: errors.slice(0, 3), errorCount: errors.length }
                : {}),
            };
          })
        );
        evidence('projects', compiled);
        const failed = compiled.filter((project) => !project.ok);
        if (failed.length > 0) {
          throw new Error(`${failed.map((project) => project.project).join(', ')} did not compile`);
        }
      }
    );
  },
};

/** Proves the cogitator binary works against generated projects without a model. */
const cliStage: StageDefinition = {
  id: 'cli',
  title: 'CLI',
  description:
    'The cogitator binary prints its version and help, tells a runtime config apart from an assistant config, creates and validates a skill, plans an addition with cogitator add, checks a project with cogitator doctor and plans a deploy of the API project.',
  packages: [CLI],
  needs: ['scaffold'],
  timeoutMs: 180_000,
  async run(ctx) {
    const basic = projectDir(ctx, 'basic');

    await ctx.check('--version and --help', async (evidence) => {
      const version = await cli(['--version'], ctx.tmpDir, ctx);
      const help = await cli(['--help'], ctx.tmpDir, ctx);
      const manifest = await readPackageJson(join(dirname(cliEntry()), '..'));
      evidence('version', version.stdout.trim());
      const commands = [
        'init',
        'add',
        'dev',
        'mcp',
        'doctor',
        'eval',
        'up',
        'run',
        'deploy',
        'skill',
        'daemon',
        'build',
        'wizard',
      ];
      const missing = commands.filter(
        (command) => !new RegExp(`^\\s+${command}\\b`, 'm').test(help.stdout)
      );
      evidence('missingCommands', missing);
      if (version.stdout.trim() !== manifest.version) {
        throw new Error(
          `--version printed ${version.stdout.trim()}, package.json says ${manifest.version}`
        );
      }
      if (help.code !== 0 || missing.length > 0)
        throw new Error(`--help lacks ${missing.join(', ')}`);
    });

    await ctx.check('up explains a runtime config instead of running it', async (evidence) => {
      const result = await cli(['up'], basic, ctx);
      const output = plain(result.stdout + result.stderr);
      evidence('exitCode', result.code);
      evidence('output', excerpt(output, 240));
      if (result.code === 0)
        throw new Error('up succeeded on a runtime config with nothing to start');
      if (!/runtime config/i.test(output))
        throw new Error('up did not say the file is a runtime config');
    });

    await ctx.check('skill create, validate and list', async (evidence) => {
      const created = await cli(
        ['skill', 'create', 'gauntlet-probe', '--template', 'basic'],
        basic,
        ctx
      );
      evidence('create', excerpt(created.stdout, 120));
      if (created.code !== 0)
        throw new Error(`skill create exited ${created.code}: ${excerpt(created.stderr)}`);
      evidence('files', await listFiles(join(basic, 'skills', 'gauntlet-probe')));
      const validated = await cli(
        ['skill', 'validate', 'skills/gauntlet-probe'],
        basic,
        ctx,
        90_000
      );
      evidence('validate', excerpt(validated.stdout + validated.stderr, 240));
      if (validated.code !== 0) throw new Error(`skill validate exited ${validated.code}`);
      const listed = await cli(['skill', 'list'], basic, ctx);
      if (!listed.stdout.includes('gauntlet-probe'))
        throw new Error('skill list does not show the new skill');
    });

    await ctx.check('add plans RAG for the basic project without writing', async (evidence) => {
      const result = await cli(['add', 'rag', '--dry-run', '--json'], basic, ctx);
      const plan = JSON.parse(result.stdout) as {
        ok: boolean;
        added: string[];
        changes: Array<{ path: string; kind: string }>;
        dependencies: Record<string, string>;
      };
      evidence('added', plan.added);
      evidence(
        'changes',
        plan.changes.map((change) => `${change.kind} ${change.path}`)
      );
      if (result.code !== 0 || !plan.ok) throw new Error(`add exited ${result.code}`);
      if (!plan.changes.some((change) => change.path === 'src/rag/knowledge-base.ts')) {
        throw new Error('the plan does not create the knowledge base');
      }
      if (!plan.dependencies['@cogitator-ai/rag'])
        throw new Error('the plan does not add @cogitator-ai/rag');
      if (existsSync(join(basic, 'src', 'rag'))) throw new Error('--dry-run wrote files');
    });

    await ctx.check('doctor checks the basic project offline', async (evidence) => {
      const result = await cli(['doctor', '--offline', '--json'], basic, ctx);
      const report = JSON.parse(result.stdout) as {
        ok: boolean;
        checks: Array<{ id: string; status: string }>;
      };
      evidence(
        'checks',
        report.checks.map((check) => `${check.id}: ${check.status}`)
      );
      if (!report.checks.some((check) => check.id === 'node' && check.status === 'pass')) {
        throw new Error('doctor did not check Node');
      }
      if ((result.code === 0) !== report.ok)
        throw new Error('the exit code does not follow the checks');
    });

    await ctx.check('deploy --dry-run plans the API project', async (evidence) => {
      const result = await cli(
        ['deploy', '--dry-run', '--json'],
        projectDir(ctx, 'api-server'),
        ctx
      );
      const plan = JSON.parse(result.stdout) as {
        config: { server?: string };
        secrets: string[];
        preflight: { checks: Array<{ name: string }> };
      };
      evidence('plan', { server: plan.config.server, secrets: plan.secrets });
      if (plan.config.server !== 'express') throw new Error(`the server is ${plan.config.server}`);
      for (const secret of ['OPENAI_API_KEY', 'API_TOKEN']) {
        if (!plan.secrets.includes(secret)) throw new Error(`the plan does not ask for ${secret}`);
      }
      if (plan.preflight.checks.length === 0) throw new Error('no preflight checks');
    });
  },
};

/** Proves `cogitator run` reaches a real model when cogitator.yml points the OpenAI provider at OpenRouter. */
const cliRunStage: StageDefinition = {
  id: 'cli-run',
  title: 'CLI run on OpenRouter',
  description:
    'cogitator run answers one-shot prompts, streamed and not, on the gauntlet model through a cogitator.yml that points the OpenAI provider at OpenRouter.',
  packages: [CLI, CONFIG],
  needs: ['handshake'],
  requires: [
    {
      kind: 'env',
      name: 'OPENROUTER_API_KEY',
      why: 'the CLI reads it through ${OPENROUTER_API_KEY}',
    },
  ],
  timeoutMs: 120_000,
  async run(ctx) {
    const model = ctx.model.replace(/^openrouter\//, 'openai/');
    await writeFile(
      join(ctx.tmpDir, 'cogitator.yml'),
      [
        'llm:',
        `  defaultModel: ${model}`,
        '  providers:',
        '    openai:',
        '      apiKey: ${OPENROUTER_API_KEY}',
        '      baseUrl: https://openrouter.ai/api/v1',
        '      api: chat-completions',
        '',
      ].join('\n')
    );
    ctx.log('The CLI runs in its own process: its tokens are not metered by the gauntlet');

    for (const stream of [false, true]) {
      await ctx.check(
        stream ? 'run streams an answer' : 'run --no-stream answers',
        async (evidence) => {
          const args = [
            'run',
            ...(stream ? [] : ['--no-stream']),
            'Reply with exactly the word PONG and nothing else.',
          ];
          const result = await cli(args, ctx.tmpDir, ctx, 90_000);
          evidence('model', model);
          evidence('exitCode', result.code);
          evidence('answer', excerpt(result.stdout.trim().split('\n').at(-1) ?? '', 120));
          if (result.code !== 0) {
            throw new Error(
              `run exited ${result.code}: ${excerpt(result.stdout + result.stderr, 240)}`
            );
          }
          if (!/pong/i.test(result.stdout)) throw new Error('The answer did not contain PONG');
        }
      );
    }
  },
};

function artifactText(artifacts: GeneratedArtifacts, path: string): string {
  const file = artifacts.files.find((entry) => entry.path === path);
  if (!file) throw new Error(`No ${path} among the generated artifacts`);
  return file.content;
}

/** Proves the deploy engine reads generated projects and writes deploy artifacts that fit them. */
const deployArtifacts: StageDefinition = {
  id: 'deploy-artifacts',
  title: 'Deploy artifacts',
  description:
    'The deploy engine analyzes the generated projects (server, services, secrets, build), writes a production Dockerfile, compose and fly.toml for them, gates on secrets, and points the health check at a route the server serves.',
  packages: [DEPLOY],
  needs: ['scaffold'],
  timeoutMs: 60_000,
  async run(ctx) {
    const deployer = new Deployer();
    const api = projectDir(ctx, 'api-server');
    const memory = projectDir(ctx, 'memory');

    const apiPlan = await ctx.check(
      'the analyzer reads the generated projects',
      async (evidence) => {
        const plan = await deployer.plan({ projectDir: api, target: 'docker', noPush: true });
        const memoryPlan = await deployer.plan({
          projectDir: memory,
          target: 'docker',
          noPush: true,
        });
        const flyBasic = await deployer.plan({
          projectDir: projectDir(ctx, 'basic'),
          target: 'fly',
          noPush: true,
        });
        evidence('api', {
          server: plan.analysis.server,
          secrets: plan.config.secrets,
          start: plan.analysis.startCommand,
          build: plan.analysis.hasBuildScript,
        });
        evidence('memory', {
          services: memoryPlan.config.services,
          secrets: memoryPlan.config.secrets,
        });
        evidence('flyBasicWarnings', flyBasic.warnings);
        if (plan.analysis.server !== 'express')
          throw new Error('The express server was not detected');
        for (const secret of ['OPENAI_API_KEY', 'API_TOKEN']) {
          if (!plan.config.secrets?.includes(secret)) throw new Error(`${secret} was not required`);
        }
        if (!plan.analysis.hasTypeScript || !plan.analysis.hasBuildScript) {
          throw new Error('The TypeScript build was missed');
        }
        if (!memoryPlan.config.services?.redis) {
          throw new Error('The redis memory adapter did not add a redis service');
        }
        if (!memoryPlan.config.secrets?.includes('ANTHROPIC_API_KEY')) {
          throw new Error('ANTHROPIC_API_KEY was not required');
        }
        if (!flyBasic.warnings.some((warning) => /ollama/i.test(warning))) {
          throw new Error('A local Ollama model on Fly.io raised no warning');
        }
        return plan;
      }
    );

    await ctx.check(
      'the production Dockerfile, compose and fly.toml fit the project',
      async (evidence) => {
        const docker = await apiPlan.provider.generate(apiPlan.config, api);
        const flyPlan = await deployer.plan({ projectDir: api, target: 'fly', noPush: true });
        const fly = await flyPlan.provider.generate(flyPlan.config, api);
        const memoryPlan = await deployer.plan({
          projectDir: memory,
          target: 'docker',
          noPush: true,
        });
        const memoryCompose = artifactText(
          await memoryPlan.provider.generate(memoryPlan.config, memory),
          'docker-compose.prod.yml'
        );
        const dockerfile = artifactText(docker, 'Dockerfile');
        const compose = artifactText(docker, 'docker-compose.prod.yml');
        const flyToml = artifactText(fly, 'fly.toml');
        evidence('files', {
          docker: docker.files.map((file) => file.path),
          fly: fly.files.map((file) => file.path),
        });
        evidence(
          'dockerfileCmd',
          dockerfile.split('\n').find((line) => line.startsWith('CMD'))
        );
        const expectations: Array<[string, boolean]> = [
          ['Dockerfile builds on node:24-alpine', /^FROM node:24-alpine/m.test(dockerfile)],
          ['Dockerfile installs with pnpm', dockerfile.includes('pnpm install')],
          ['Dockerfile runs the build script', dockerfile.includes('pnpm run build')],
          ['Dockerfile prunes dev dependencies', dockerfile.includes('pnpm prune --prod')],
          ['Dockerfile runs as the node user', /^USER node$/m.test(dockerfile)],
          ['Dockerfile runs under tini', dockerfile.includes('/sbin/tini')],
          ['Dockerfile exposes the port', /^EXPOSE 3000$/m.test(dockerfile)],
          ['Dockerfile has a HEALTHCHECK', /^HEALTHCHECK /m.test(dockerfile)],
          ['compose maps the port', compose.includes('"3000:3000"')],
          [
            'compose passes the secret through',
            compose.includes('OPENAI_API_KEY: ${OPENAI_API_KEY'),
          ],
          [
            'memory compose starts redis',
            /^\s{2}redis:/m.test(memoryCompose) && memoryCompose.includes('REDIS_URL'),
          ],
          ['fly.toml names the app', flyToml.includes('app = "gauntlet-api-server"')],
          ['fly.toml routes the port', flyToml.includes('internal_port = 3000')],
        ];
        const failed = expectations.filter(([, ok]) => !ok).map(([name]) => name);
        evidence('failed', failed);
        if (failed.length > 0) throw new Error(failed.join('; '));
      }
    );

    await ctx.check('preflight gates on secrets and reads them from .env', async (evidence) => {
      const options = { projectDir: memory, target: 'docker', noPush: true, dryRun: true } as const;
      const secret = 'ANTHROPIC_API_KEY';
      const secretCheck = `Secret: ${secret}`;
      if (process.env[secret]) {
        ctx.log(
          `${secret} is set in this environment, so the missing-secret path is not exercised`
        );
      } else {
        const blocked = await deployer.deploy(options);
        evidence('withoutSecret', {
          success: blocked.success,
          error: excerpt(blocked.error ?? '', 160),
        });
        if (blocked.success || !blocked.error?.includes(secret)) {
          throw new Error('deploy() did not fail on the missing secret');
        }
      }
      await writeFile(join(memory, '.env'), `${secret}=gauntlet-placeholder\n`);
      const plan = await deployer.plan(options);
      const check = plan.preflight.checks.find((entry) => entry.name === secretCheck);
      evidence('withDotenv', check);
      if (!check?.passed) throw new Error(`The ${secret} in .env did not satisfy the preflight`);
    });

    await ctx.check('the health check targets a route the server serves', async (evidence) => {
      const healthPath = apiPlan.config.health?.path ?? '';
      const source = await readFile(join(api, 'src', 'index.ts'), 'utf8');
      const basePath = /basePath:\s*'([^']+)'/.exec(source)?.[1] ?? '';
      const served = `${basePath}/health`;
      evidence('healthCheckPath', healthPath);
      evidence('serverHealthRoute', served);
      if (!basePath || healthPath !== served) {
        throw new Error(
          `The HEALTHCHECK probes ${healthPath} but the scaffolded server serves ${served}`
        );
      }
    });
  },
};

/** Proves the generated production image builds from the workspace packages and serves the API. */
const deployDocker: StageDefinition = {
  id: 'deploy-docker',
  title: 'Deploy image',
  description:
    'The production Dockerfile of the scaffolded API project builds with the workspace packages vendored in, the container serves the agent API as an unprivileged user, and its own HEALTHCHECK passes.',
  packages: [DEPLOY],
  needs: ['scaffold'],
  requires: [{ kind: 'docker' }],
  timeoutMs: 600_000,
  async run(ctx) {
    const source = projectDir(ctx, 'api-server');
    const api = join(ctx.tmpDir, 'image');
    await scaffold(
      specOf({
        key: 'api-server',
        preset: 'api-server',
        provider: 'openai',
        overrides: { deploy: 'docker' },
      }),
      {
        directory: api,
        install: false,
        git: false,
      }
    );
    ctx.log(
      `Built from a fresh copy of ${relative(ctx.tmpDir, source)} with the workspace packages packed into vendor/`
    );
    const docker = (args: readonly string[], timeoutMs = 60_000) =>
      runProcess('docker', args, { cwd: api, env: childEnv(), timeoutMs, signal: ctx.signal });

    const plan = await ctx.check(
      'the project installs from vendored workspace packages',
      async (evidence) => {
        const vendored = await vendorWorkspacePackages(api, async (packageDir, destination) => {
          const packed = await runProcess(
            'pnpm',
            ['pack', '--pack-destination', destination, '--json'],
            {
              cwd: packageDir,
              env: childEnv(),
              timeoutMs: 120_000,
              signal: ctx.signal,
            }
          );
          if (packed.code !== 0)
            throw new Error(`pnpm pack failed in ${packageDir}: ${excerpt(packed.stderr)}`);
          const parsed = JSON.parse(packed.stdout.slice(packed.stdout.indexOf('{'))) as {
            filename: string;
          };
          return relative(destination, resolve(destination, parsed.filename));
        });
        evidence('vendored', vendored);
        const install = await runProcess('pnpm', ['install'], {
          cwd: api,
          env: childEnv(),
          timeoutMs: 300_000,
          signal: ctx.signal,
        });
        if (install.code !== 0)
          throw new Error(`pnpm install failed: ${excerpt(install.stdout + install.stderr, 300)}`);
        const deployer = new Deployer();
        const deployPlan = await deployer.plan({ projectDir: api, target: 'docker', noPush: true });
        const artifacts = await deployPlan.provider.generate(deployPlan.config, api);
        for (const file of artifacts.files) {
          if (file.path === 'Dockerfile' || file.path === '.dockerignore') {
            await writeFile(join(api, file.path), file.content);
          }
        }
        return deployPlan;
      }
    );

    await ctx.check("the Dockerfile passes docker's own checks", async (evidence) => {
      const lint = await docker(['build', '--check', '.'], 120_000);
      evidence('buildCheck', { code: lint.code, output: excerpt(lint.stdout + lint.stderr, 240) });
      if (lint.code !== 0) throw new Error(`docker build --check failed: ${excerpt(lint.stderr)}`);
    });

    const image = `gauntlet-edges-api:${Date.now().toString(36)}`;
    await ctx.check('the image builds', async (evidence) => {
      ctx.onCleanup(async () => {
        await runProcess('docker', ['rmi', '-f', image], { cwd: api, timeoutMs: 30_000 });
      });
      const build = await docker(['build', '-q', '-t', image, '.'], 480_000);
      evidence('image', image);
      evidence('seconds', Math.round(build.durationMs / 1000));
      if (build.code !== 0) throw new Error(`docker build failed: ${excerpt(build.stderr, 300)}`);
    });

    const port = await ctx.freePort();
    const container = await ctx.check('the container serves the agent API', async (evidence) => {
      const secrets = plan.config.secrets ?? [];
      evidence('secrets', secrets);
      const run = await docker([
        'run',
        '-d',
        '-p',
        `127.0.0.1:${port}:3000`,
        ...secrets.flatMap((secret) => ['-e', `${secret}=gauntlet-placeholder`]),
        image,
      ]);
      const id = run.stdout.trim();
      if (run.code !== 0 || !id) throw new Error(`docker run failed: ${excerpt(run.stderr)}`);
      ctx.onCleanup(async () => {
        await runProcess('docker', ['rm', '-f', id], { cwd: api, timeoutMs: 30_000 });
      });
      const deadline = Date.now() + 45_000;
      let status = 0;
      while (Date.now() < deadline) {
        status = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctx.signal })
          .then((response) => response.status)
          .catch(() => 0);
        if (status === 200) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
      const user = await docker(['exec', id, 'whoami']);
      evidence('port', port);
      evidence('apiHealth', status);
      evidence('user', user.stdout.trim());
      if (status !== 200) {
        const logs = await docker(['logs', '--tail', '20', id]);
        throw new Error(
          `/api/health answered ${status}: ${excerpt(logs.stdout + logs.stderr, 300)}`
        );
      }
      if (user.stdout.trim() === 'root') throw new Error('The container runs as root');
      return id;
    });

    await ctx.check("the image's HEALTHCHECK passes", async (evidence) => {
      const inspect = await docker([
        'inspect',
        '--format',
        '{{json .Config.Healthcheck.Test}}',
        image,
      ]);
      const test = z.array(z.string()).parse(JSON.parse(inspect.stdout));
      const command =
        test[0] === 'CMD-SHELL' ? ['sh', '-c', test.slice(1).join(' ')] : test.slice(1);
      const probe = await docker(['exec', container, ...command]);
      evidence('healthcheck', test.slice(1).join(' '));
      evidence('exitCode', probe.code);
      if (probe.code !== 0) throw new Error('The HEALTHCHECK fails against the running container');
    });
  },
};

async function waitForRun(base: string, runId: string, signal: AbortSignal): Promise<RunRecord> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/runs/${runId}`, { signal });
    const tree = (await response.json()) as { run: RunRecord };
    if (['completed', 'failed', 'stopped'].includes(tree.run.status)) return tree.run;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Run ${runId} did not finish within 240 s`);
}

/** Proves generated projects run on a small local model, from the terminal and in Cogitator Studio. */
const localModelStage: StageDefinition = {
  id: 'scaffold-ollama',
  title: 'Generated projects on a local model',
  description: `The basic and assistant projects of create-cogitator-app answer on a small Ollama model (${OLLAMA_MODEL}) from their own entry point, and Cogitator Studio runs them with a trace of the model calls.`,
  packages: [CCA, STUDIO, CLI],
  requires: [{ kind: 'ollama', model: OLLAMA_MODEL }],
  timeoutMs: 600_000,
  async run(ctx) {
    const projects: Record<string, string> = {};
    await ctx.check('the projects scaffold for the local model', async (evidence) => {
      for (const key of ['basic', 'assistant']) {
        const directory = join(ctx.tmpDir, `local-${key}`);
        await scaffold(specOf({ key, preset: key, provider: 'ollama' }, OLLAMA_MODEL), {
          directory,
          install: false,
          git: false,
        });
        const linked = await link(directory);
        const runtime = Object.keys((await readPackageJson(directory)).dependencies ?? {});
        const missing = linked.missing.filter((spec) =>
          runtime.some((name) => spec.startsWith(`${name}@`))
        );
        await mkdir(join(directory, 'data'), { recursive: true });
        projects[key] = directory;
        evidence(key, linked);
        if (missing.length > 0) throw new Error(`${key} misses ${missing.join(', ')}`);
      }
    });

    for (const key of ['basic', 'assistant']) {
      await ctx.check(`the ${key} project answers from its entry point`, async (evidence) => {
        const result = await runProcess(
          process.execPath,
          ['--import', TSX_LOADER, 'src/index.ts', 'What is 6 times 7? Answer with the number.'],
          { cwd: projects[key] ?? '', env: childEnv(), timeoutMs: 240_000, signal: ctx.signal }
        );
        evidence('exitCode', result.code);
        evidence('answer', excerpt(result.stdout, 200));
        if (result.code !== 0)
          throw new Error(`exited ${result.code}: ${excerpt(result.stderr, 300)}`);
        if (!result.stdout.trim()) throw new Error('no answer');
      });
    }

    await ctx.check('Cogitator Studio runs the assistant with a trace', async (evidence) => {
      const studio = await startStudio({
        projectDir: projects.assistant ?? '',
        port: await ctx.freePort(),
        strictPort: true,
        watch: false,
      });
      ctx.onCleanup(() => studio.close());
      await studio.ready();
      const base = `http://127.0.0.1:${studio.port}`;
      const started = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'assistant', input: 'Say hello in one short sentence.' }),
        signal: ctx.signal,
      });
      if (started.status !== 202)
        throw new Error(`/api/chat answered ${started.status}: ${await started.text()}`);
      const { runId } = (await started.json()) as { runId: string };
      const run = await waitForRun(base, runId, ctx.signal);
      const llm = run.spans.filter((span) => span.kind === 'llm');
      evidence('status', run.status);
      evidence('output', excerpt(run.output ?? run.error ?? '', 200));
      evidence('modelCalls', llm.length);
      evidence('tokens', run.usage);
      if (run.status !== 'completed') throw new Error(`the run ${run.status}: ${run.error ?? ''}`);
      if (llm.length === 0 || (run.usage?.inputTokens ?? 0) === 0)
        throw new Error('the trace has no model call with tokens');
    });
  },
};

export const toolingStages: StageDefinition[] = [
  scaffoldStage,
  cliStage,
  cliRunStage,
  deployArtifacts,
  deployDocker,
  localModelStage,
];
