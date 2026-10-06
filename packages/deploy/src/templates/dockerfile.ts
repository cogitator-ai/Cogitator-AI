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

export const NODE_IMAGE = 'node:22-alpine';
export const BUN_IMAGE = 'oven/bun:1-alpine';

const DEFAULT_INSTALL_FILES: Record<DockerfilePackageManager, readonly string[]> = {
  pnpm: ['pnpm-lock.yaml*'],
  npm: ['package-lock.json*'],
  yarn: ['yarn.lock*'],
  'yarn-berry': ['yarn.lock*', '.yarnrc.yml*'],
  bun: ['bun.lock*'],
};

interface InstallSteps {
  copy: string[];
  install: string;
  installProd: string;
  build: string;
  runtimeSetup?: string;
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

function installSteps(options: DockerfileOptions, pm: DockerfilePackageManager): InstallSteps {
  const locked = options.hasLockfile ?? true;
  const copy = copyInstallFiles(pm, options.installFiles);
  switch (pm) {
    case 'pnpm':
      return {
        copy,
        install: `RUN corepack enable && pnpm install${locked ? ' --frozen-lockfile' : ''}`,
        installProd: `RUN corepack enable && pnpm install${locked ? ' --frozen-lockfile' : ''} --prod`,
        build: 'RUN pnpm run build',
      };
    case 'yarn':
      return {
        copy,
        install: `RUN corepack enable && yarn install${locked ? ' --frozen-lockfile' : ''}`,
        installProd: `RUN corepack enable && yarn install${locked ? ' --frozen-lockfile' : ''} --production`,
        build: 'RUN yarn run build',
      };
    case 'yarn-berry': {
      const install = `RUN corepack enable && yarn install${locked ? ' --immutable' : ''}`;
      const focusable = Number.parseInt(options.packageManagerVersion ?? '', 10) >= 4;
      return {
        copy,
        install,
        installProd: focusable
          ? 'RUN corepack enable && yarn workspaces focus --all --production'
          : install,
        build: 'RUN yarn run build',
        runtimeSetup: 'RUN corepack enable',
      };
    }
    case 'bun':
      return {
        copy,
        install: `RUN bun install${locked ? ' --frozen-lockfile' : ''}`,
        installProd: `RUN bun install${locked ? ' --frozen-lockfile' : ''} --production`,
        build: 'RUN bun run build',
      };
    case 'npm':
      return {
        copy,
        install: locked ? 'RUN npm ci' : 'RUN npm install',
        installProd: locked ? 'RUN npm ci --omit=dev' : 'RUN npm install --omit=dev',
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

export function generateDockerfile(options: DockerfileOptions): string {
  const { config, hasTypeScript } = options;
  const pm = options.packageManager ?? 'pnpm';
  const image = pm === 'bun' ? BUN_IMAGE : NODE_IMAGE;
  const runtime = pm === 'bun' ? 'bun' : 'node';
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
  const runtimeTail = [
    env,
    http ? `EXPOSE ${port}` : undefined,
    http ? healthcheck(config, port) : undefined,
    `CMD ${JSON.stringify(startCommand)}`,
  ];

  if (!hasTypeScript) {
    return lines(
      `FROM ${image}`,
      'WORKDIR /app',
      ...steps.copy,
      steps.installProd,
      'COPY . .',
      ...runtimeTail
    );
  }

  return lines(
    `FROM ${image} AS builder`,
    'WORKDIR /app',
    ...steps.copy,
    steps.install,
    'COPY . .',
    options.hasBuildScript === false ? undefined : steps.build,
    '',
    `FROM ${image} AS runtime`,
    'WORKDIR /app',
    steps.runtimeSetup,
    'COPY --from=builder /app ./',
    ...runtimeTail
  );
}
