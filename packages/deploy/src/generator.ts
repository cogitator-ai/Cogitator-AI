import type { DeployConfig, GeneratedArtifact, GeneratedArtifacts } from '@cogitator-ai/types';
import { generateDockerfile, type DockerfilePackageManager } from './templates/dockerfile.js';
import { generateDockerCompose } from './templates/docker-compose.js';
import { generateFlyToml } from './templates/fly-toml.js';
import { projectVolumePaths } from './volumes.js';

export interface GeneratorOptions {
  hasTypeScript: boolean;
  packageManager?: DockerfilePackageManager;
  hasLockfile?: boolean;
  hasBuildScript?: boolean;
  startCommand?: string[];
  /** Project files the install step reads, directories with a trailing slash */
  installFiles?: string[];
  /** Version from the `packageManager` field of package.json */
  packageManagerVersion?: string;
}

export const ARTIFACTS_DIR = '.cogitator';

export const DOCKERIGNORE = `node_modules
dist
.git
.gitignore
.env
.env.*
*.md
.cogitator
`;

/** The `.dockerignore` of `config`: the defaults, and the volume directories, whose local data must not ship in the image. */
export function dockerignoreFor(config: DeployConfig): string {
  const volumes = projectVolumePaths(config.volumes);
  return volumes.length > 0 ? `${DOCKERIGNORE}${volumes.join('\n')}\n` : DOCKERIGNORE;
}

export class ArtifactGenerator {
  generate(config: DeployConfig, options: GeneratorOptions): GeneratedArtifacts {
    const files: GeneratedArtifact[] = [];
    const target = config.target ?? 'docker';
    const dockerignore = dockerignoreFor(config);

    files.push({
      path: 'Dockerfile',
      content: generateDockerfile({ config, ...options }),
    });

    files.push({ path: '.dockerignore', content: dockerignore });
    files.push({ path: 'Dockerfile.dockerignore', content: dockerignore });

    if (target === 'docker') {
      files.push({
        path: 'docker-compose.prod.yml',
        content: generateDockerCompose(config),
      });
    }

    if (target === 'fly') {
      files.push({
        path: 'fly.toml',
        content: generateFlyToml(config),
      });
    }

    return { files, outputDir: ARTIFACTS_DIR };
  }
}
