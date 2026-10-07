import type { DeployConfig } from '@cogitator-ai/types';
import { healthPath, servesHttp } from './health.js';

/**
 * The package manager a Dockerfile installs with. `yarn` is Yarn 1 (classic),
 * `yarn-berry` is Yarn 2 and later.
 */
export type DockerfilePackageManager = 'pnpm' | 'npm' | 'yarn' | 'yarn-berry' | 'bun';

export interface DockerfileOptions {
  config: DeployConfig;
  hasTypeScript: boolean;
  packageManager?: DockerfilePackageManager;
  hasLockfile?: boolean;
  hasBuildScript?: boolean;
  startCommand?: string[];
  /** Project files the install step reads, copied with package.json before it runs, directories with a trailing slash */
  installFiles?: string[];
  /** Version from the `packageManager` field of package.json */
  packageManagerVersion?: string;
}

export const NODE_IMAGE = 'node:24-alpine';
export const BUN_IMAGE = 'oven/bun:1-alpine';

const DEFAULT_INSTALL_FILES: Record<DockerfilePackageManager, readonly string[]> = {
  pnpm: ['pnpm-lock.yaml*'],
  npm: ['package-lock.json*'],
  yarn: ['yarn.lock*'],
  'yarn-berry': ['yarn.lock*', '.yarnrc.yml*'],
  bun: ['bun.lock*'],
};

/** Where each package manager keeps its download cache, mounted as a BuildKit cache across builds. */
const CACHE_DIRS: Record<DockerfilePackageManager, string> = {
  pnpm: '/root/.local/share/pnpm/store',
  npm: '/root/.npm',
  yarn: '/usr/local/share/.cache/yarn',
  'yarn-berry': '/root/.yarn/berry/cache',
  bun: '/root/.bun/install/cache',
};

interface InstallSteps {
  copy: string[];
  /** Every dependency, for the build. */
  install: string;
  /** Production dependencies only, for an image that does not build. */
  installProd: string;
  /** Drops the dev dependencies the build needed from an installed tree, in place. */
  prune?: string;
  build: string;
}

function copyInstallFiles(
  pm: DockerfilePackageManager,
  files: readonly string[] | undefined
): string[] {
  if (!files) return [`COPY package.json ${DEFAULT_INSTALL_FILES[pm].join(' ')} ./`];
  const directories = files.filter((file) => file.endsWith('/')).map((dir) => dir.slice(0, -1));
  const plain = files.filter((file) => !file.endsWith('/'));
  return [
    `COPY ${['package.json', ...plain].join(' ')} ./`,
    ...directories.map((dir) => `COPY ${dir} ./${dir}`),
  ];
}

function cached(pm: DockerfilePackageManager, command: string): string {
  return `RUN --mount=type=cache,id=${pm},target=${CACHE_DIRS[pm]} ${command}`;
}

function installSteps(options: DockerfileOptions, pm: DockerfilePackageManager): InstallSteps {
  const locked = options.hasLockfile ?? true;
  const copy = copyInstallFiles(pm, options.installFiles);
  switch (pm) {
    case 'pnpm': {
      const frozen = locked ? ' --frozen-lockfile' : '';
      return {
        copy,
        install: cached(pm, `pnpm install${frozen}`),
        installProd: cached(pm, `pnpm install${frozen} --prod`),
        prune: cached(pm, 'pnpm prune --prod --ignore-scripts'),
        build: 'RUN pnpm run build',
      };
    }
    case 'yarn': {
      const frozen = locked ? ' --frozen-lockfile' : '';
      return {
        copy,
        install: cached(pm, `yarn install${frozen}`),
        installProd: cached(pm, `yarn install${frozen} --production`),
        prune: cached(pm, `yarn install${frozen} --production --ignore-scripts --prefer-offline`),
        build: 'RUN yarn run build',
      };
    }
    case 'yarn-berry': {
      const install = cached(pm, `yarn install${locked ? ' --immutable' : ''}`);
      const focusable = Number.parseInt(options.packageManagerVersion ?? '', 10) >= 4;
      const focus = cached(pm, 'yarn workspaces focus --all --production');
      return {
        copy,
        install,
        installProd: focusable ? focus : install,
        ...(focusable && { prune: focus }),
        build: 'RUN yarn run build',
      };
    }
    case 'bun': {
      const frozen = locked ? ' --frozen-lockfile' : '';
      return {
        copy,
        install: cached(pm, `bun install${frozen}`),
        installProd: cached(pm, `bun install${frozen} --production`),
        prune: cached(
          pm,
          `rm -rf node_modules && bun install${frozen} --production --ignore-scripts`
        ),
        build: 'RUN bun run build',
      };
    }
    case 'npm':
      return {
        copy,
        install: cached(pm, locked ? 'npm ci' : 'npm install'),
        installProd: cached(pm, locked ? 'npm ci --omit=dev' : 'npm install --omit=dev'),
        prune: cached(pm, 'npm prune --omit=dev'),
        build: 'RUN npm run build',
      };
  }
}

/**
 * The image's HEALTHCHECK. It probes 127.0.0.1 rather than `localhost`: inside an Alpine image
 * `localhost` resolves to `::1` first, which a server bound to `0.0.0.0` (IPv4 only) refuses,
 * while a dual-stack server answers on 127.0.0.1 too.
 */
function healthcheck(config: DeployConfig, port: number): string | undefined {
  const path = healthPath(config);
  if (!path) return undefined;
  const interval = config.health?.interval ?? '30s';
  const timeout = config.health?.timeout ?? '5s';
  return `HEALTHCHECK --interval=${interval} --timeout=${timeout} CMD wget -q --spider http://127.0.0.1:${port}${path} || exit 1`;
}

function lines(...entries: (string | undefined | false)[]): string {
  return entries.filter((entry): entry is string => typeof entry === 'string').join('\n') + '\n';
}

/**
 * A production image: dependencies installed from the lockfile with the
 * package manager's cache kept between builds, TypeScript built in a builder
 * stage that then drops its dev dependencies, and a runtime stage that runs as
 * the image's unprivileged user under tini, so signals reach the app and child
 * processes (MCP servers, sandboxes) are reaped.
 */
export function generateDockerfile(options: DockerfileOptions): string {
  const { config, hasTypeScript } = options;
  const pm = options.packageManager ?? 'pnpm';
  const bun = pm === 'bun';
  const image = bun ? BUN_IMAGE : NODE_IMAGE;
  const user = bun ? 'bun' : 'node';
  const runtime = bun ? 'bun' : 'node';
  const steps = installSteps(options, pm);
  const startCommand = options.startCommand ?? [
    runtime,
    hasTypeScript ? 'dist/server.js' : 'src/server.js',
  ];
  const http = servesHttp(config);
  const port = config.port ?? 3000;
  const env = [
    'ENV NODE_ENV=production',
    http ? `PORT=${port}` : undefined,
    startCommand[0] === 'npm' ? 'NPM_CONFIG_UPDATE_NOTIFIER=false' : undefined,
  ]
    .filter((entry) => entry !== undefined)
    .join(' ');
  const corepack = pm === 'pnpm' || pm === 'yarn' || pm === 'yarn-berry';

  const base = [
    `FROM ${image} AS base`,
    'WORKDIR /app',
    corepack ? 'RUN corepack enable' : undefined,
  ];
  const runtimeStage = (copy: string[]) => [
    'FROM base AS runtime',
    'RUN apk add --no-cache tini && chown ' + user + ':' + user + ' /app',
    env,
    ...copy,
    `USER ${user}`,
    http ? `EXPOSE ${port}` : undefined,
    http ? healthcheck(config, port) : undefined,
    'ENTRYPOINT ["/sbin/tini", "--"]',
    `CMD ${JSON.stringify(startCommand)}`,
  ];

  if (!hasTypeScript) {
    return lines(
      '# syntax=docker/dockerfile:1',
      ...base,
      '',
      'FROM base AS deps',
      ...steps.copy,
      steps.installProd,
      '',
      ...runtimeStage([
        `COPY --from=deps --chown=${user}:${user} /app/node_modules ./node_modules`,
        `COPY --chown=${user}:${user} . .`,
      ])
    );
  }

  return lines(
    '# syntax=docker/dockerfile:1',
    ...base,
    '',
    'FROM base AS builder',
    'RUN apk add --no-cache python3 make g++',
    ...steps.copy,
    steps.install,
    'COPY . .',
    options.hasBuildScript === false ? undefined : steps.build,
    steps.prune,
    '',
    ...runtimeStage([`COPY --from=builder --chown=${user}:${user} /app ./`])
  );
}
