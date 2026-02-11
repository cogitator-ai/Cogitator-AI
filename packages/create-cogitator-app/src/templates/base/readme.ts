import type { ProjectOptions, TemplateFile } from '../../types.js';
import { devCommand } from '../../utils/package-manager.js';

const templateNames: Record<string, string> = {
  basic: 'Basic Agent',
  memory: 'Agent with Memory',
  swarm: 'Multi-Agent Swarm',
  workflow: 'DAG Workflow',
  'api-server': 'REST API Server',
  nextjs: 'Next.js Chat App',
};

export function generateReadme(options: ProjectOptions): TemplateFile {
  const dev = devCommand(options.packageManager);
  const templateName = templateNames[options.template] || options.template;

  const content = [
    `# ${options.name}`,
    '',
    `> Created with [create-cogitator-app](https://github.com/cogitator-ai/cogitator) — ${templateName} template`,
    '',
    '## Getting Started',
    '',
    '```bash',
    `# Install dependencies`,
    `${options.packageManager} install`,
    '',
    `# Run the project`,
    dev,
    '```',
    '',
    ...(options.docker
      ? ['## Docker Services', '', '```bash', 'docker compose up -d', '```', '']
      : []),
    '## Learn More',
    '',
    '- [Cogitator Documentation](https://cogitator.dev/docs)',
    '- [GitHub Repository](https://github.com/cogitator-ai/cogitator)',
    '',
  ];

  return { path: 'README.md', content: content.join('\n') };
}
