import type { DeployConfig } from '@cogitator-ai/types';

export type DockerfilePackageManager = 'pnpm' | 'npm' | 'yarn';

export interface DockerfileOptions {
  config: DeployConfig;
  hasTypeScript: boolean;
  packageManager?: DockerfilePackageManager;
  hasLockfile?: boolean;
  hasBuildScript?: boolean;
  startCommand?: string[];
}

export const NODE_IMAGE = 'node:22-alpine';

interface InstallSteps {
  copy: string;
  install: string;
  installProd: string;
  build: string;
}

function installSteps(pm: DockerfilePackageManager, hasLockfile: boolean): InstallSteps {
  switch (pm) {
    case 'pnpm':
      return {
        copy: 'COPY package.json pnpm-lock.yaml* ./',
        install: `RUN corepack enable && pnpm install${hasLockfile ? ' --frozen-lockfile' : ''}`,
        installProd: `RUN corepack enable && pnpm install${hasLockfile ? ' --frozen-lockfile' : ''} --prod`,
        build: 'RUN pnpm run build',
      };
    case 'yarn':
      return {
        copy: 'COPY package.json yarn.lock* .yarnrc.yml* ./',
        install: `RUN corepack enable && yarn install${hasLockfile ? ' --frozen-lockfile' : ''}`,
        installProd: `RUN corepack enable && yarn install${hasLockfile ? ' --frozen-lockfile' : ''} --production`,
        build: 'RUN yarn run build',
      };
    case 'npm':
      return {
        copy: 'COPY package.json package-lock.json* ./',
        install: hasLockfile ? 'RUN npm ci' : 'RUN npm install',
        installProd: hasLockfile ? 'RUN npm ci --omit=dev' : 'RUN npm install --omit=dev',
        build: 'RUN npm run build',
      };
  }
}

function healthcheck(config: DeployConfig, port: number): string {
  const path = config.health?.path ?? '/health';
  const interval = config.health?.interval ?? '30s';
  const timeout = config.health?.timeout ?? '5s';
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `HEALTHCHECK --interval=${interval} --timeout=${timeout} CMD wget -q --spider http://localhost:${port}${normalizedPath} || exit 1`;
}

export function generateDockerfile(options: DockerfileOptions): string {
  const { config, hasTypeScript } = options;
  const port = config.port ?? 3000;
  const pm = options.packageManager ?? 'pnpm';
  const steps = installSteps(pm, options.hasLockfile ?? true);
  const startCommand = options.startCommand ?? [
    'node',
    hasTypeScript ? 'dist/server.js' : 'src/server.js',
  ];
  const cmd = `CMD ${JSON.stringify(startCommand)}`;
  const env = `ENV NODE_ENV=production PORT=${port}`;

  if (!hasTypeScript) {
    return `FROM ${NODE_IMAGE}
WORKDIR /app
${steps.copy}
${steps.installProd}
COPY . .
${env}
EXPOSE ${port}
${healthcheck(config, port)}
${cmd}
`;
  }

  const build = options.hasBuildScript === false ? '' : `${steps.build}\n`;

  return `FROM ${NODE_IMAGE} AS builder
WORKDIR /app
${steps.copy}
${steps.install}
COPY . .
${build}
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
COPY --from=builder /app ./
${env}
EXPOSE ${port}
${healthcheck(config, port)}
${cmd}
`;
}
