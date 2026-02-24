import { describe, it, expect } from 'vitest';
import { getTemplate, templateChoices } from '../templates/index.js';
import { defaultModels } from '../utils/providers.js';
import type { ProjectOptions } from '../types.js';

const baseOptions: ProjectOptions = {
  name: 'test-project',
  path: '/tmp/test-project',
  template: 'basic',
  provider: 'ollama',
  packageManager: 'pnpm',
  docker: false,
  git: false,
};

describe('template registry', () => {
  it('has all expected templates registered', () => {
    const names = templateChoices.map((c) => c.value);
    expect(names).toContain('basic');
    expect(names).toContain('memory');
    expect(names).toContain('swarm');
    expect(names).toContain('workflow');
    expect(names).toContain('api-server');
    expect(names).toContain('nextjs');
  });

  it('getTemplate returns correct template for each type', () => {
    for (const choice of templateChoices) {
      expect(() => getTemplate(choice.value)).not.toThrow();
    }
  });
});

describe('defaultModels', () => {
  it('uses gemini-2.5-flash for google (not 2.0)', () => {
    expect(defaultModels.google).toBe('gemini-2.5-flash');
    expect(defaultModels.google).not.toContain('2.0');
  });

  it('has models for all providers', () => {
    expect(defaultModels.ollama).toBeTruthy();
    expect(defaultModels.openai).toBeTruthy();
    expect(defaultModels.anthropic).toBeTruthy();
    expect(defaultModels.google).toBeTruthy();
  });
});

describe('basic template', () => {
  const template = getTemplate('basic');
  const opts = { ...baseOptions, template: 'basic' as const };

  it('generates src/index.ts and src/tools.ts', () => {
    const files = template.files(opts);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/tools.ts');
  });

  it('has cogitator-ai/core dependency', () => {
    expect(template.dependencies()).toHaveProperty('@cogitator-ai/core');
  });

  it('has tsx in devDependencies', () => {
    expect(template.devDependencies()).toHaveProperty('tsx');
  });

  it('has dev and start scripts', () => {
    const scripts = template.scripts();
    expect(scripts).toHaveProperty('dev');
    expect(scripts).toHaveProperty('start');
  });

  it('interpolates project name into generated code', () => {
    const files = template.files(opts);
    const indexTs = files.find((f) => f.path === 'src/index.ts')!;
    expect(indexTs.content).toContain('test-project');
  });
});

describe('memory template', () => {
  const template = getTemplate('memory');
  const opts = { ...baseOptions, template: 'memory' as const };

  it('generates src/index.ts and src/tools.ts', () => {
    const files = template.files(opts);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/tools.ts');
  });

  it('has memory and redis dependencies', () => {
    const deps = template.dependencies();
    expect(deps).toHaveProperty('@cogitator-ai/memory');
    expect(deps).toHaveProperty('@cogitator-ai/redis');
  });

  it('uses threadId for memory', () => {
    const files = template.files(opts);
    const indexTs = files.find((f) => f.path === 'src/index.ts')!;
    expect(indexTs.content).toContain('threadId');
  });
});

describe('workflow template', () => {
  const template = getTemplate('workflow');
  const opts = { ...baseOptions, template: 'workflow' as const };

  it('generates src/index.ts and src/agents.ts', () => {
    const files = template.files(opts);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/agents.ts');
  });

  it('has workflows dependency', () => {
    expect(template.dependencies()).toHaveProperty('@cogitator-ai/workflows');
  });

  it('uses correct agentNode API (not old object form)', () => {
    const files = template.files(opts);
    const indexTs = files.find((f) => f.path === 'src/index.ts')!;
    expect(indexTs.content).toContain('agentNode<WorkflowState>(analyzer');
    expect(indexTs.content).not.toContain('agentNode({');
  });

  it('uses inputMapper and stateMapper', () => {
    const files = template.files(opts);
    const indexTs = files.find((f) => f.path === 'src/index.ts')!;
    expect(indexTs.content).toContain('inputMapper');
    expect(indexTs.content).toContain('stateMapper');
  });

  it('does not reference ctx.results (wrong API)', () => {
    const files = template.files(opts);
    const indexTs = files.find((f) => f.path === 'src/index.ts')!;
    expect(indexTs.content).not.toContain('ctx.results');
  });

  it('uses .fn when passing to addNode', () => {
    const files = template.files(opts);
    const indexTs = files.find((f) => f.path === 'src/index.ts')!;
    expect(indexTs.content).toContain('.fn');
  });
});

describe('swarm template', () => {
  const template = getTemplate('swarm');
  const opts = { ...baseOptions, template: 'swarm' as const };

  it('generates expected files', () => {
    const files = template.files(opts);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/tools.ts');
    expect(paths).toContain('src/agents/researcher.ts');
    expect(paths).toContain('src/agents/writer.ts');
    expect(paths).toContain('src/agents/reviewer.ts');
  });

  it('has swarms dependency', () => {
    expect(template.dependencies()).toHaveProperty('@cogitator-ai/swarms');
  });

  it('does not use coordination wrapper in hierarchical config', () => {
    const files = template.files(opts);
    const indexTs = files.find((f) => f.path === 'src/index.ts')!;
    expect(indexTs.content).not.toContain('coordination:');
    expect(indexTs.content).not.toContain('maxParallelTasks');
  });

  it('uses correct hierarchical config fields', () => {
    const files = template.files(opts);
    const indexTs = files.find((f) => f.path === 'src/index.ts')!;
    expect(indexTs.content).toContain("visibility: 'full'");
    expect(indexTs.content).toContain('workerCommunication: true');
  });
});

describe('api-server template', () => {
  const template = getTemplate('api-server');
  const opts = { ...baseOptions, template: 'api-server' as const };

  it('generates server files', () => {
    const files = template.files(opts);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/index.ts');
  });

  it('has express dependency', () => {
    const deps = template.dependencies();
    expect(deps).toHaveProperty('express');
  });
});

describe('template provider interpolation', () => {
  const providers = ['ollama', 'openai', 'anthropic', 'google'] as const;

  for (const provider of providers) {
    it(`basic template works with ${provider} provider`, () => {
      const template = getTemplate('basic');
      const opts = { ...baseOptions, provider, template: 'basic' as const };
      expect(() => template.files(opts)).not.toThrow();
      const files = template.files(opts);
      const indexTs = files.find((f) => f.path === 'src/index.ts')!;
      expect(indexTs.content).toContain(defaultModels[provider]);
    });
  }
});
