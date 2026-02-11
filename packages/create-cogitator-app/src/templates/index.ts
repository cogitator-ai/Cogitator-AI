import type { Template, TemplateGenerator } from '../types.js';
import { basicTemplate } from './basic.js';
import { memoryTemplate } from './memory.js';
import { swarmTemplate } from './swarm.js';
import { workflowTemplate } from './workflow.js';
import { apiServerTemplate } from './api-server.js';
import { nextjsTemplate } from './nextjs.js';

const templates: Record<Template, TemplateGenerator> = {
  basic: basicTemplate,
  memory: memoryTemplate,
  swarm: swarmTemplate,
  workflow: workflowTemplate,
  'api-server': apiServerTemplate,
  nextjs: nextjsTemplate,
};

export function getTemplate(name: Template): TemplateGenerator {
  return templates[name];
}

export const templateChoices: Array<{
  value: Template;
  label: string;
  hint: string;
}> = [
  {
    value: 'basic',
    label: 'Basic agent',
    hint: 'Single agent with tools — best for getting started',
  },
  { value: 'memory', label: 'Agent with memory', hint: 'Persistent memory with Redis' },
  {
    value: 'swarm',
    label: 'Multi-agent swarm',
    hint: 'Team of agents with hierarchical coordination',
  },
  { value: 'workflow', label: 'DAG workflow', hint: 'Multi-step pipeline with checkpoints' },
  {
    value: 'api-server',
    label: 'REST API server',
    hint: 'Express server exposing agents via HTTP',
  },
  { value: 'nextjs', label: 'Next.js chat app', hint: 'Full-stack chat app with streaming' },
];
