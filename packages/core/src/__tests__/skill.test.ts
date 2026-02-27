import { describe, it, expect } from 'vitest';
import { defineSkill, validateSkill, mergeSkillsIntoAgent } from '../skill';
import { Agent } from '../agent';
import { tool } from '../tool';
import { z } from 'zod';

const searchTool = tool({
  name: 'web_search',
  description: 'Search the web',
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => ({ results: [`Result for: ${query}`] }),
});

const calcTool = tool({
  name: 'calculator',
  description: 'Calculate math',
  parameters: z.object({ expression: z.string() }),
  execute: async ({ expression }) => ({ result: expression }),
});

const emailTool = tool({
  name: 'send_email',
  description: 'Send an email',
  parameters: z.object({ to: z.string(), body: z.string() }),
  execute: async () => ({ sent: true }),
});

describe('defineSkill', () => {
  it('creates a skill from config', () => {
    const skill = defineSkill({
      name: 'web-search',
      version: '1.0.0',
      description: 'Search the web',
      tools: [searchTool],
      instructions: 'Use web_search to find information.',
    });

    expect(skill.name).toBe('web-search');
    expect(skill.version).toBe('1.0.0');
    expect(skill.tools).toHaveLength(1);
    expect(skill.tools[0].name).toBe('web_search');
    expect(skill.instructions).toBe('Use web_search to find information.');
  });

  it('creates skill without optional fields', () => {
    const skill = defineSkill({
      name: 'calc',
      version: '0.1.0',
      description: 'Calculator',
      tools: [calcTool],
    });

    expect(skill.instructions).toBeUndefined();
    expect(skill.env).toBeUndefined();
    expect(skill.dependencies).toBeUndefined();
  });
});

describe('validateSkill', () => {
  it('validates a correct skill', () => {
    const skill = defineSkill({
      name: 'test',
      version: '1.0.0',
      description: 'Test skill',
      tools: [searchTool],
    });

    const result = validateSkill(skill);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails on empty name', () => {
    const skill = defineSkill({
      name: '',
      version: '1.0.0',
      description: 'Test',
      tools: [searchTool],
    });

    const result = validateSkill(skill);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Skill name is required');
  });

  it('warns on no tools', () => {
    const skill = defineSkill({
      name: 'empty',
      version: '1.0.0',
      description: 'Empty skill',
      tools: [],
    });

    const result = validateSkill(skill);
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain('Skill has no tools');
  });

  it('detects missing env vars', () => {
    const skill = defineSkill({
      name: 'test',
      version: '1.0.0',
      description: 'Test',
      tools: [searchTool],
      env: ['NONEXISTENT_VAR_12345'],
    });

    const result = validateSkill(skill);
    expect(result.valid).toBe(false);
    expect(result.missingEnv).toContain('NONEXISTENT_VAR_12345');
  });
});

describe('mergeSkillsIntoAgent', () => {
  it('merges tools from multiple skills', () => {
    const result = mergeSkillsIntoAgent([calcTool], 'Base instructions.', [
      defineSkill({
        name: 'search',
        version: '1.0.0',
        description: 'Search',
        tools: [searchTool],
        instructions: 'Search instructions.',
      }),
      defineSkill({
        name: 'email',
        version: '1.0.0',
        description: 'Email',
        tools: [emailTool],
        instructions: 'Email instructions.',
      }),
    ]);

    expect(result.tools).toHaveLength(3);
    expect(result.tools.map((t) => t.name)).toEqual(['calculator', 'web_search', 'send_email']);
    expect(result.instructions).toContain('Base instructions.');
    expect(result.instructions).toContain('Search instructions.');
    expect(result.instructions).toContain('Email instructions.');
  });

  it('deduplicates tools by name', () => {
    const result = mergeSkillsIntoAgent([searchTool], 'Instructions', [
      defineSkill({
        name: 'search',
        version: '1.0.0',
        description: 'Search',
        tools: [searchTool],
      }),
    ]);

    expect(result.tools).toHaveLength(1);
  });

  it('handles skills without instructions', () => {
    const result = mergeSkillsIntoAgent([], 'Base', [
      defineSkill({
        name: 'calc',
        version: '1.0.0',
        description: 'Calc',
        tools: [calcTool],
      }),
    ]);

    expect(result.instructions).toBe('Base');
  });
});

describe('Agent + Skills integration', () => {
  it('agent accepts skills and merges tools', () => {
    const skill = defineSkill({
      name: 'web-search',
      version: '1.0.0',
      description: 'Web search skill',
      tools: [searchTool],
      instructions: 'Always cite sources.',
    });

    const agent = new Agent({
      name: 'assistant',
      model: 'test/model',
      instructions: 'You are helpful.',
      tools: [calcTool],
      skills: [skill],
    });

    expect(agent.tools).toHaveLength(2);
    expect(agent.tools.map((t) => t.name)).toContain('web_search');
    expect(agent.tools.map((t) => t.name)).toContain('calculator');
    expect(agent.instructions).toContain('You are helpful.');
    expect(agent.instructions).toContain('Always cite sources.');
  });

  it('agent works without skills', () => {
    const agent = new Agent({
      name: 'basic',
      model: 'test/model',
      instructions: 'Hello',
      tools: [calcTool],
    });

    expect(agent.tools).toHaveLength(1);
    expect(agent.instructions).toBe('Hello');
  });

  it('clone preserves skills', () => {
    const skill = defineSkill({
      name: 'search',
      version: '1.0.0',
      description: 'Search',
      tools: [searchTool],
      instructions: 'Search stuff.',
    });

    const agent = new Agent({
      name: 'original',
      model: 'test/model',
      instructions: 'Base.',
      skills: [skill],
    });

    const cloned = agent.clone({ temperature: 0.5 });
    expect(cloned.tools).toHaveLength(1);
    expect(cloned.tools[0].name).toBe('web_search');
  });
});
