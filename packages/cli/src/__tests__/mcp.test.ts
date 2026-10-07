import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from '@cogitator-ai/types';
import { loadDocsIndex, readDoc, searchDocs, slugOf, type DocsIndex } from '../utils/docs.js';
import { describeRegistry, inspectRegistry } from '../utils/registry.js';
import { findProjectRoot, projectTools } from '../commands/mcp.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'registry-project');

let docsDir: string;
let index: DocsIndex;

beforeAll(() => {
  docsDir = mkdtempSync(join(tmpdir(), 'cogitator-docs-'));
  mkdirSync(join(docsDir, 'tools'), { recursive: true });
  writeFileSync(
    join(docsDir, 'index.md'),
    [
      '# Cogitator 1.2.3 documentation',
      '',
      '## Tools',
      '',
      '- [Tool Approvals](tools/approvals.md): Pause a run until a person approves a tool call.',
      '- [Custom Tools](tools/custom-tools.md): Build tools with Zod parameters.',
      '',
    ].join('\n')
  );
  writeFileSync(
    join(docsDir, 'tools/approvals.md'),
    '# Tool Approvals\n\nIntro.\n\n## Approving a call\n\nSet requiresApproval on the tool and pass onApproval to the run.\n\n## Timeouts\n\nCalls wait for a decision.\n'
  );
  writeFileSync(
    join(docsDir, 'tools/custom-tools.md'),
    '# Custom Tools\n\nUse tool() with a Zod schema. A tool can also set requiresApproval.\n'
  );
  index = loadDocsIndex({ dir: docsDir, version: '1.2.3' });
});

afterAll(() => rmSync(docsDir, { recursive: true, force: true }));

describe('bundled docs search', () => {
  it('reads the catalog from index.md', () => {
    expect(index.entries.map((entry) => [entry.path, entry.section])).toEqual([
      ['tools/approvals.md', 'Tools'],
      ['tools/custom-tools.md', 'Tools'],
    ]);
  });

  it('ranks the page about the query first and points at the best section', () => {
    const [first, second] = searchDocs(index, 'approval run');
    expect(first.path).toBe('tools/approvals.md');
    expect(first.heading).toBe('Approving a call');
    expect(first.snippet).toContain('onApproval');
    expect(second).toBeUndefined();
  });

  it('reads a page or one section of it', () => {
    expect(readDoc(index, 'tools/custom-tools.md')).toContain('Zod schema');
    const section = readDoc(index, `tools/approvals.md#${slugOf('Approving a call')}`);
    expect(section).toBe(
      '## Approving a call\n\nSet requiresApproval on the tool and pass onApproval to the run.'
    );
  });

  it('refuses paths outside the docs', () => {
    expect(() => readDoc(index, '../../package.json')).toThrow(/no doc page/);
    expect(() => readDoc(index, 'tools/../../secrets.md')).toThrow(/no doc page/);
  });
});

describe('project registry', () => {
  it('describes agents, tools, workflows and swarms by shape', async () => {
    const registry = await inspectRegistry(FIXTURE);
    expect(registry.agents).toEqual([
      {
        key: 'assistant',
        name: 'assistant',
        description: 'Answers questions',
        instructions: 'Answer briefly.',
        tools: [
          expect.objectContaining({ name: 'lookup', requiresApproval: false }),
          expect.objectContaining({ name: 'publish', requiresApproval: true }),
        ],
      },
      {
        key: 'writer',
        name: 'writer',
        model: 'anthropic/claude-sonnet-5-5',
        instructions: 'Write.',
        tools: [],
      },
    ]);
    expect(registry.agents[0].tools[0].parameters).toMatchObject({
      type: 'object',
      properties: { word: { type: 'string' } },
    });
    expect(registry.workflows).toEqual([
      {
        key: 'report',
        name: 'report',
        entryPoint: 'draft',
        nodes: ['draft', 'review'],
        edges: [{ type: 'sequential', from: 'draft', to: ['review'] }],
      },
    ]);
    expect(registry.swarms).toEqual([
      { key: 'panel', name: 'panel', strategy: 'debate', agents: ['writer', 'assistant'] },
    ]);
  });

  it('reports a registry that fails to load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cogitator-broken-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(join(dir, 'src/cogitator.ts'), "throw new Error('the config is broken');\n");
      await expect(inspectRegistry(dir)).rejects.toThrow('the config is broken');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('explains a project without a registry', async () => {
    await expect(inspectRegistry(tmpdir())).rejects.toThrow(/src\/cogitator.ts not found/);
  });

  it('ignores exports that are not agents', () => {
    expect(
      describeRegistry({ agents: { helper: () => 1, broken: { config: {} } } }).agents
    ).toEqual([]);
  });
});

describe('MCP tools', () => {
  function named(tools: Tool[], name: string): Tool {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  }

  it('serve the installed docs and the project registry', async () => {
    const tools = projectTools(FIXTURE);
    expect(tools.map((t) => t.name)).toEqual([
      'search_docs',
      'read_doc',
      'inspect_project',
      'check_project',
    ]);

    const results = await named(tools, 'search_docs').execute(
      { query: 'tool approvals' },
      {} as never
    );
    expect(String(results)).toMatch(/read_doc "tools\/approvals.md/);

    const project = JSON.parse(
      String(await named(tools, 'inspect_project').execute({}, {} as never))
    );
    expect(project.scaffold.generator).toBe('create-cogitator-app@0.0.0');
    expect(project.agents.map((agent: { key: string }) => agent.key)).toEqual([
      'assistant',
      'writer',
    ]);
  });
});

describe('findProjectRoot', () => {
  it('walks up from a subdirectory to the project', () => {
    expect(findProjectRoot(join(FIXTURE, 'src'))).toBe(FIXTURE);
  });

  it('stays where it started outside a project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cogitator-nowhere-'));
    try {
      expect(findProjectRoot(dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
