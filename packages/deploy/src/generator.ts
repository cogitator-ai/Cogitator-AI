import type { DeployConfig, GeneratedArtifact, GeneratedArtifacts } from '@cogitator-ai/types';
import { generateDockerfile } from './templates/dockerfile.js';
import { generateDockerCompose } from './templates/docker-compose.js';
import { generateFlyToml } from './templates/fly-toml.js';

export interface GeneratorOptions {
  hasTypeScript: boolean;
}

const DOCKERIGNORE = `node_modules
dist
.git
.gitignore
.env
.env.*
*.md
.cogitator
`;

export class ArtifactGenerator {
  generate(config: DeployConfig, options: GeneratorOptions): GeneratedArtifacts {
    const files: GeneratedArtifact[] = [];
    const target = config.target ?? 'docker';

    files.push({
      path: 'Dockerfile',
      content: generateDockerfile({ config, hasTypeScript: options.hasTypeScript }),
    });

    files.push({
      path: '.dockerignore',
      content: DOCKERIGNORE,
    });

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

    return { files, outputDir: '.cogitator' };
  }
}
