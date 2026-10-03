import type { ProjectOptions, TemplateFile } from '../../types.js';
import { devCommand } from '../../utils/package-manager.js';
import { DOCS_URL, REPO_URL } from '../../utils/links.js';

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
    `> Created with [create-cogitator-app](${REPO_URL}) — ${templateName} template`,
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
    `- [Cogitator Documentation](${DOCS_URL})`,
    `- [GitHub Repository](${REPO_URL})`,
    '',
  ];

  return { path: 'README.md', content: content.join('\n') };
}
