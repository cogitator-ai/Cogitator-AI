import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@cogitator-ai/config';
import { Deployer } from '@cogitator-ai/deploy';
import type { GeneratedArtifacts } from '@cogitator-ai/types';
import {
  defaultModels,
  providerEnvKey,
  type LLMProvider,
  type ProjectOptions,
  type Template,
} from 'create-cogitator-app';
import { z } from 'zod';
import type { StageContext, StageDefinition } from '../../runner/types.js';
import { excerpt, plain, runProcess } from './shared.js';
import { findInstalled, linkDependencies } from './workspace.js';

const CCA = 'create-cogitator-app';
const CLI = '@cogitator-ai/cli';
const DEPLOY = '@cogitator-ai/deploy';
const CONFIG = '@cogitator-ai/config';

declare module '../../runner/types.js' {
  interface GauntletArtifacts {
    /** Generated projects by template name. */
    edgesProjects: Partial<Record<Template, string>>;
  }
}

interface ProjectSpec {
  template: Template;
  provider: LLMProvider;
  docker: boolean;
}

const PROJECTS: readonly ProjectSpec[] = [
  { template: 'basic', provider: 'ollama', docker: false },
  { template: 'memory', provider: 'anthropic', docker: true },
  { template: 'swarm', provider: 'google', docker: false },
  { template: 'workflow', provider: 'ollama', docker: false },
  { template: 'api-server', provider: 'openai', docker: true },
  { template: 'nextjs', provider: 'openai', docker: false },
];

/** Templates that need packages the monorepo does not install (Next.js, React). */
const NOT_COMPILED: ReadonlySet<Template> = new Set(['nextjs']);

/** Runs `scaffold()` in a child process, so its spinner and its package install stay out of the gauntlet. */
const SCAFFOLD_SCRIPT = `const { scaffold } = await import(process.env.GAUNTLET_CCA_LIB);
await scaffold(JSON.parse(process.env.GAUNTLET_CCA_OPTIONS));
`;

/**
 * Stands in for the package manager `scaffold()` always runs: it records the call instead of
 * installing the published packages from npm, so the project is checked against this workspace.
 */
const PNPM_SHIM = `#!/bin/sh
echo "$PWD|$*" >> "$GAUNTLET_PNPM_LOG"
exit 0
`;

/** The environment of child processes, read when they start: the gauntlet loads its .env after import. */
function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' };
}

function projects(ctx: StageContext): Partial<Record<Template, string>> {
  return ctx.artifacts.get('edgesProjects');
}

function projectDir(ctx: StageContext, template: Template): string {
  const dir = projects(ctx)[template];
  if (!dir) throw new Error(`The scaffold stage produced no ${template} project`);
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

/** Relative imports in the generated sources that point at no generated file. */
async function danglingImports(dir: string, files: readonly string[]): Promise<string[]> {
  const dangling: string[] = [];
  for (const file of files.filter((name) => /\.(ts|tsx)$/.test(name))) {
    const source = await readFile(join(dir, file), 'utf8');
    for (const match of source.matchAll(/from ['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(join(dir, file)), match[1] ?? '');
      const candidates = [target, target.replace(/\.js$/, '.ts'), `${target}.ts`, `${target}.tsx`];
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

/** Proves every create-cogitator-app template scaffolds programmatically into a coherent project that compiles. */
const scaffoldStage: StageDefinition = {
  id: 'scaffold',
  title: 'Project scaffolding',
  description:
    'scaffold() from create-cogitator-app generates every template, the files agree with each other, and the TypeScript templates compile against the workspace packages.',
  packages: [CCA, CONFIG],
  timeoutMs: 150_000,
  async run(ctx) {
    const shimDir = join(ctx.tmpDir, 'bin');
    const installLog = join(ctx.tmpDir, 'pnpm-calls.log');
    const script = join(ctx.tmpDir, 'scaffold.mjs');
    await mkdir(shimDir, { recursive: true });
    await writeFile(join(shimDir, 'pnpm'), PNPM_SHIM, { mode: 0o755 });
    await writeFile(script, SCAFFOLD_SCRIPT);
    const generated: Partial<Record<Template, string>> = {};

    await ctx.check('every template scaffolds through scaffold()', async (evidence) => {
      const outcomes = await Promise.all(
        PROJECTS.map(async (spec) => {
          const options: ProjectOptions = {
            name: `gauntlet-${spec.template}`,
            path: join(ctx.tmpDir, `gauntlet-${spec.template}`),
            template: spec.template,
            provider: spec.provider,
            packageManager: 'pnpm',
            docker: spec.docker,
            git: false,
          };
          const result = await runProcess(process.execPath, [script], {
            cwd: ctx.tmpDir,
            env: {
              ...childEnv(),
              PATH: `${shimDir}:${process.env.PATH ?? ''}`,
              GAUNTLET_PNPM_LOG: installLog,
              GAUNTLET_CCA_LIB: import.meta.resolve(CCA),
              GAUNTLET_CCA_OPTIONS: JSON.stringify(options),
            },
            timeoutMs: 60_000,
            signal: ctx.signal,
          });
          if (result.code !== 0) {
            throw new Error(
              `${spec.template}: scaffold exited ${result.code}: ${excerpt(result.stderr)}`
            );
          }
          generated[spec.template] = options.path;
          return {
            template: spec.template,
            files: (await listFiles(options.path)).length,
            ms: result.durationMs,
          };
        })
      );
      const installs = existsSync(installLog)
        ? (await readFile(installLog, 'utf8')).trim().split('\n').filter(Boolean)
        : [];
      evidence('projects', outcomes);
      evidence('installCalls', installs.length);
      if (
        installs.length !== PROJECTS.length ||
        !installs.every((line) => line.endsWith('|install'))
      ) {
        throw new Error(`Expected one "pnpm install" per project, saw ${installs.length}`);
      }
      ctx.artifacts.set('edgesProjects', generated);
    });

    await ctx.check('generated files agree with each other', async (evidence) => {
      const problems: string[] = [];
      const summary: Array<Record<string, unknown>> = [];
      for (const spec of PROJECTS) {
        const dir = projectDir(ctx, spec.template);
        const files = await listFiles(dir);
        const pkg = await readPackageJson(dir);
        const model = defaultModels[spec.provider];
        const say = (problem: string) => problems.push(`${spec.template}: ${problem}`);

        if (pkg.name !== `gauntlet-${spec.template}`) say(`package.json name is ${pkg.name}`);
        if (!pkg.dependencies?.['@cogitator-ai/core']) say('no @cogitator-ai/core dependency');
        if (!pkg.scripts?.dev) say('no dev script');
        if (spec.template !== 'nextjs' && pkg.type !== 'module') {
          say('package.json is not an ES module');
        }
        if (spec.docker !== files.includes('docker-compose.yml')) {
          say('docker-compose.yml does not follow the docker option');
        }

        const config = loadConfig({ configPath: join(dir, 'cogitator.yml'), skipEnv: true });
        if (config.llm?.defaultProvider !== spec.provider) {
          say(`cogitator.yml provider is ${config.llm?.defaultProvider}`);
        }
        if (config.llm?.defaultModel !== model) {
          say(`cogitator.yml model is ${config.llm?.defaultModel}`);
        }
        if (spec.template === 'memory' && config.memory?.adapter !== 'redis') {
          say('memory template does not configure redis');
        }

        const sources = await Promise.all(
          files
            .filter((file) => /\.(ts|tsx)$/.test(file))
            .map((file) => readFile(join(dir, file), 'utf8'))
        );
        if (!sources.some((source) => source.includes(model))) {
          say(`no source uses the configured model ${model}`);
        }
        const envExample = await readFile(join(dir, '.env.example'), 'utf8');
        if (!envExample.includes(providerEnvKey(spec.provider))) {
          say(`.env.example lacks ${providerEnvKey(spec.provider)}`);
        }
        const dangling = await danglingImports(dir, files);
        if (dangling.length > 0) say(`dangling imports ${dangling.join(', ')}`);

        summary.push({
          template: spec.template,
          provider: spec.provider,
          model,
          files: files.length,
        });
      }
      evidence('projects', summary);
      evidence('problems', problems);
      if (problems.length > 0) throw new Error(problems.join('; '));
    });

    await ctx.check(
      'TypeScript templates compile against the workspace packages',
      async (evidence) => {
        const compiled = await Promise.all(
          PROJECTS.filter((spec) => !NOT_COMPILED.has(spec.template)).map(async (spec) => {
            const dir = projectDir(ctx, spec.template);
            const pkg = await readPackageJson(dir);
            const { linked, missing } = await linkDependencies(dir, {
              ...pkg.dependencies,
              ...pkg.devDependencies,
            });
            const typescript = findInstalled('typescript', pkg.devDependencies?.typescript ?? '*');
            if (!typescript) {
              return {
                template: spec.template,
                ok: false,
                error: 'no matching typescript installed',
              };
            }
            const result = await runProcess(
              process.execPath,
              [join(typescript.dir, 'bin', 'tsc'), '-p', 'tsconfig.json', '--noEmit'],
              { cwd: dir, env: childEnv(), timeoutMs: 90_000, signal: ctx.signal }
            );
            const errors = plain(result.stdout)
              .split('\n')
              .filter((line) => line.includes('error TS'));
            return {
              template: spec.template,
              ok: result.code === 0,
              typescript: typescript.version,
              linked: linked.map((dep) => `${dep.name}@${dep.version}`),
              ...(missing.length > 0 ? { missing } : {}),
              ...(errors.length > 0
                ? { errors: errors.slice(0, 3), errorCount: errors.length }
                : {}),
            };
          })
        );
        evidence('projects', compiled);
        const failed = compiled.filter((project) => !project.ok);
        if (failed.length > 0) {
          throw new Error(
            `${failed.map((project) => project.template).join(', ')} did not compile`
          );
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
    'The cogitator binary prints its version and help, tells a runtime config apart from an assistant config, creates and validates a skill in a project, and plans a deploy of the API project.',
  packages: [CLI],
  needs: ['scaffold'],
  timeoutMs: 120_000,
  async run(ctx) {
    const basic = projectDir(ctx, 'basic');

    await ctx.check('--version and --help', async (evidence) => {
      const version = await cli(['--version'], ctx.tmpDir, ctx);
      const help = await cli(['--help'], ctx.tmpDir, ctx);
      const manifest = await readPackageJson(join(dirname(cliEntry()), '..'));
      evidence('version', version.stdout.trim());
      const commands = ['init', 'up', 'run', 'deploy', 'skill', 'daemon', 'build', 'wizard'];
      const missing = commands.filter(
        (command) => !new RegExp(`^\\s+${command}\\b`, 'm').test(help.stdout)
      );
      evidence('missingCommands', missing);
      if (version.stdout.trim() !== manifest.version) {
        throw new Error(
          `--version printed ${version.stdout.trim()}, package.json says ${manifest.version}`
        );
      }
      if (help.code !== 0 || missing.length > 0) {
        throw new Error(`--help lacks ${missing.join(', ')}`);
      }
    });

    await ctx.check('up explains a runtime config instead of running it', async (evidence) => {
      const result = await cli(['up'], basic, ctx);
      const output = plain(result.stdout + result.stderr);
      evidence('exitCode', result.code);
      evidence('output', excerpt(output, 240));
      if (result.code === 0) {
        throw new Error('up succeeded on a runtime config with nothing to start');
      }
      if (!/runtime config/i.test(output)) {
        throw new Error('up did not say the file is a runtime config');
      }
    });

    await ctx.check('skill create, validate and list', async (evidence) => {
      const created = await cli(
        ['skill', 'create', 'gauntlet-probe', '--template', 'basic'],
        basic,
        ctx
      );
      evidence('create', excerpt(created.stdout, 120));
      if (created.code !== 0) {
        throw new Error(`skill create exited ${created.code}: ${excerpt(created.stderr)}`);
      }
      const skillDir = join(basic, 'skills', 'gauntlet-probe');
      evidence('files', await listFiles(skillDir));
      const validated = await cli(
        ['skill', 'validate', 'skills/gauntlet-probe'],
        basic,
        ctx,
        90_000
      );
      evidence('validate', excerpt(validated.stdout + validated.stderr, 240));
      if (validated.code !== 0) throw new Error(`skill validate exited ${validated.code}`);
      const listed = await cli(['skill', 'list'], basic, ctx);
      if (!listed.stdout.includes('gauntlet-probe')) {
        throw new Error('skill list does not show the new skill');
      }
    });

    await ctx.check('deploy --dry-run plans the API project', async (evidence) => {
      const result = await cli(['deploy', '--dry-run'], projectDir(ctx, 'api-server'), ctx);
      const output = plain(result.stdout + result.stderr);
      evidence('exitCode', result.code);
      evidence('output', excerpt(output, 300));
      for (const expected of ['Deploy plan', 'express', 'OPENAI_API_KEY', 'Preflight']) {
        if (!output.includes(expected)) throw new Error(`The plan does not mention ${expected}`);
      }
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
    'The deploy engine analyzes the generated projects (server, services, secrets, build), writes Dockerfile, compose and fly.toml for them, gates on secrets, and points the health check at a route the server serves.',
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
        if (plan.analysis.server !== 'express') {
          throw new Error('The express server was not detected');
        }
        if (!plan.config.secrets?.includes('OPENAI_API_KEY')) {
          throw new Error('OPENAI_API_KEY was not required');
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

    await ctx.check('Dockerfile, compose and fly.toml fit the project', async (evidence) => {
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
        ['Dockerfile builds on node:22-alpine', /^FROM node:22-alpine/m.test(dockerfile)],
        ['Dockerfile runs the build script', dockerfile.includes('npm run build')],
        ['Dockerfile exposes the port', /^EXPOSE 3000$/m.test(dockerfile)],
        ['Dockerfile has a HEALTHCHECK', /^HEALTHCHECK /m.test(dockerfile)],
        ['compose maps the port', compose.includes('"3000:3000"')],
        ['compose passes the secret through', compose.includes('OPENAI_API_KEY: ${OPENAI_API_KEY')],
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
    });

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
      const healthPath = apiPlan.config.health?.path ?? '/cogitator/health';
      const source = await readFile(join(api, 'src', 'index.ts'), 'utf8');
      const basePath = /basePath:\s*'([^']+)'/.exec(source)?.[1] ?? '/cogitator';
      const served = `${basePath}/health`;
      evidence('healthCheckPath', healthPath);
      evidence('serverHealthRoute', served);
      if (healthPath !== served) {
        throw new Error(
          `The generated HEALTHCHECK and fly check probe ${healthPath} but the scaffolded server serves ${served}`
        );
      }
    });
  },
};

/** Proves the generated Docker artifacts build an image that runs the scaffolded API. */
const deployDocker: StageDefinition = {
  id: 'deploy-docker',
  title: 'Deploy image',
  description:
    'Docker accepts the generated compose file and Dockerfile, the image builds from the scaffolded API project, the container serves the agent API, and its own HEALTHCHECK passes.',
  packages: [DEPLOY],
  needs: ['scaffold'],
  requires: [{ kind: 'docker' }],
  timeoutMs: 300_000,
  async run(ctx) {
    const api = projectDir(ctx, 'api-server');
    const deployer = new Deployer();
    const plan = await deployer.plan({ projectDir: api, target: 'docker', noPush: true });
    const artifacts = await plan.provider.generate(plan.config, api);
    const outputDir = join(api, artifacts.outputDir);
    await mkdir(outputDir, { recursive: true });
    for (const file of artifacts.files) await writeFile(join(outputDir, file.path), file.content);
    ctx.log(
      'The image installs the published @cogitator-ai packages from npm, as a user build would'
    );
    const docker = (args: readonly string[], timeoutMs = 60_000) =>
      runProcess('docker', args, { cwd: api, env: childEnv(), timeoutMs, signal: ctx.signal });

    await ctx.check("compose and Dockerfile pass docker's own checks", async (evidence) => {
      const compose = await docker([
        'compose',
        '-f',
        join(outputDir, 'docker-compose.prod.yml'),
        'config',
        '--quiet',
      ]);
      const lint = await docker(
        ['build', '--check', '-f', join(outputDir, 'Dockerfile'), '.'],
        120_000
      );
      evidence('compose', { code: compose.code, stderr: excerpt(compose.stderr) });
      evidence('buildCheck', { code: lint.code, output: excerpt(lint.stdout + lint.stderr, 240) });
      if (compose.code !== 0) {
        throw new Error(`docker compose config failed: ${excerpt(compose.stderr)}`);
      }
      if (lint.code !== 0) throw new Error(`docker build --check failed: ${excerpt(lint.stderr)}`);
    });

    const image = `gauntlet-edges-api:${Date.now().toString(36)}`;
    await ctx.check('the image builds', async (evidence) => {
      ctx.onCleanup(async () => {
        await runProcess('docker', ['rmi', '-f', image], { cwd: api, timeoutMs: 30_000 });
      });
      const build = await docker(
        ['build', '-q', '-t', image, '-f', join(outputDir, 'Dockerfile'), '.'],
        240_000
      );
      evidence('image', image);
      evidence('seconds', Math.round(build.durationMs / 1000));
      if (build.code !== 0) throw new Error(`docker build failed: ${excerpt(build.stderr, 300)}`);
    });

    const port = await ctx.freePort();
    const container = await ctx.check('the container serves the agent API', async (evidence) => {
      const secrets = plan.config.secrets ?? [];
      evidence('secrets', secrets);
      if (!secrets.includes('OPENAI_API_KEY') || !secrets.includes('API_TOKEN')) {
        throw new Error(
          `The deploy plan does not ask for the API key and token: ${secrets.join(', ')}`
        );
      }
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
      evidence('port', port);
      evidence('apiHealth', status);
      if (status !== 200) {
        const logs = await docker(['logs', '--tail', '20', id]);
        throw new Error(
          `/api/health answered ${status}: ${excerpt(logs.stdout + logs.stderr, 300)}`
        );
      }
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
      evidence('output', excerpt(probe.stdout + probe.stderr));
      if (probe.code !== 0) {
        throw new Error(
          'The HEALTHCHECK fails against the running container: Docker marks it unhealthy'
        );
      }
    });
  },
};

export const toolingStages: StageDefinition[] = [
  scaffoldStage,
  cliStage,
  cliRunStage,
  deployArtifacts,
  deployDocker,
];
