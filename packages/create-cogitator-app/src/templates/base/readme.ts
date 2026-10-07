import type { ProjectOptions, TemplateFile } from '../../types.js';
import { nextSteps } from '../../next-steps.js';
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
  const templateName = templateNames[options.template] || options.template;
  const steps = nextSteps(options, { installed: false, modelReady: false });

  const content = [
    `# ${options.name}`,
    '',
    `> Created with [create-cogitator-app](${REPO_URL}) - ${templateName} template`,
    '',
    '## Getting Started',
    '',
    '```bash',
    ...steps.flatMap((step, i) => [
      ...(i > 0 ? [''] : []),
      ...(step.note ? [`# ${step.note}`] : []),
      step.command,
    ]),
    '```',
    '',
    ...(options.docker
      ? [
          '## Docker Services',
          '',
          '```bash',
          'docker compose up -d',
          '```',
          '',
          options.provider === 'ollama'
            ? 'Starts Redis, Postgres and Ollama, and pulls the model into the Ollama container.'
            : 'Starts Redis and Postgres.',
          '',
        ]
      : []),
    '## Learn More',
    '',
    `- [Cogitator Documentation](${DOCS_URL})`,
    `- [GitHub Repository](${REPO_URL})`,
    '',
  ];

  return { path: 'README.md', content: content.join('\n') };
}
