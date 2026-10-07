import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { compatibilityIssues } from '../kit/compat.js';
import { planProject, type ProjectPlan } from '../kit/plan.js';
import { PRESETS } from '../kit/presets.js';
import { defaultModel } from '../kit/providers.js';
import { parseSpec, PROVIDERS, type LLMProvider, type ProjectSpecInput } from '../kit/spec.js';

function specFor(
  presetId: string,
  provider: LLMProvider,
  overrides: Partial<ProjectSpecInput> = {}
): ProjectSpecInput {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(presetId);
  const server = preset.spec.server;
  return {
    name: 'demo-app',
    preset: preset.id,
    ...preset.spec,
    provider,
    model: defaultModel(provider),
    packageManager: server === 'tetsu' ? 'bun' : 'pnpm',
    ...overrides,
  };
}

function file(plan: ProjectPlan, path: string): string {
  const found = plan.files.find((f) => f.path === path);
  if (!found) throw new Error(`no ${path} in ${plan.files.map((f) => f.path).join(', ')}`);
  return found.content;
}

function syntaxErrors(path: string, content: string): string[] {
  const result = ts.transpileModule(content, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  return (result.diagnostics ?? []).map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, '\n')
  );
}

const combinations = PRESETS.flatMap((preset) =>
  PROVIDERS.map((provider) => ({ preset: preset.id, provider }))
).filter(
  ({ preset, provider }) => compatibilityIssues(parseSpec(specFor(preset, provider))).length === 0
);

describe('every preset and provider', () => {
  it.each(combinations)(
    '$preset with $provider generates valid TypeScript',
    ({ preset, provider }) => {
      const plan = planProject(specFor(preset, provider));
      for (const generated of plan.files) {
        if (!/\.tsx?$/.test(generated.path)) continue;
        expect(syntaxErrors(generated.path, generated.content), generated.path).toEqual([]);
      }
    }
  );

  it.each(combinations)(
    '$preset with $provider has an entry point, a registry and tests',
    ({ preset, provider }) => {
      const paths = planProject(specFor(preset, provider)).files.map((f) => f.path);
      for (const required of [
        'package.json',
        'cogitator.yml',
        'src/cogitator.ts',
        'AGENTS.md',
        'CLAUDE.md',
        'README.md',
      ]) {
        expect(paths, required).toContain(required);
      }
      expect(paths.some((p) => p.startsWith('tests/') && p.endsWith('.test.ts'))).toBe(true);
    }
  );

  it('is deterministic', () => {
    const a = planProject(specFor('basic', 'openai'));
    const b = planProject(specFor('basic', 'openai'));
    expect(a.files).toEqual(b.files);
  });
});

describe('generated configuration', () => {
  it('lists every variable env.ts reads in .env.example, required ones uncommented', () => {
    const plan = planProject(specFor('api-server', 'anthropic', { memory: 'postgres' }));
    const example = file(plan, '.env.example');
    const envTs = file(plan, 'src/env.ts');
    for (const variable of plan.env) {
      expect(envTs, variable.name).toContain(`${variable.name}:`);
      expect(example).toMatch(
        new RegExp(`^${variable.required ? '' : '# '}${variable.name}=`, 'm')
      );
    }
    expect(example).not.toMatch(/API_KEY=\S/);
  });

  it('starts only the services the stack needs, from pinned images', () => {
    const basic = planProject(specFor('basic', 'openai'));
    expect(basic.files.some((f) => f.path === 'docker-compose.yml')).toBe(false);

    const postgres = file(
      planProject(specFor('basic', 'ollama', { memory: 'postgres' })),
      'docker-compose.yml'
    );
    expect(postgres).toContain('image: pgvector/pgvector:');
    expect(postgres).toContain('image: ollama/ollama:0.');
    expect(postgres).toContain('ollama pull qwen3.5:9b');
    expect(postgres).not.toContain(':latest');
    expect(postgres).not.toContain('redis');
    expect(postgres).toContain('healthcheck:');
  });

  it('writes no compose file with --no-docker', () => {
    const plan = planProject(specFor('basic', 'ollama', { compose: false }));
    expect(plan.files.some((f) => f.path === 'docker-compose.yml')).toBe(false);
    expect(plan.services).toEqual([]);
  });

  it('keeps the model in cogitator.yml only, as provider/model', () => {
    const plan = planProject(specFor('basic', 'google'));
    expect(file(plan, 'cogitator.yml')).toContain('defaultModel: google/gemini-3.8-flash');
    expect(file(plan, 'src/agents/assistant.ts')).not.toContain('model:');
  });

  it('tells deploy which secrets a server needs and where its health check is', () => {
    const yml = file(planProject(specFor('hono', 'openai')), 'cogitator.yml');
    expect(yml).toContain('kind: server');
    expect(yml).toContain('path: /api/health');
    expect(yml).toMatch(/secrets:\n {4}- OPENAI_API_KEY\n {4}- API_TOKEN/);
  });

  it('allows the native builds pnpm and Bun would otherwise skip', () => {
    expect(file(planProject(specFor('memory', 'openai')), 'pnpm-workspace.yaml')).toBe(
      'allowBuilds:\n  better-sqlite3: true\n  esbuild: true\n'
    );
    const bun = JSON.parse(
      file(planProject(specFor('memory', 'openai', { packageManager: 'bun' })), 'package.json')
    ) as {
      trustedDependencies?: string[];
    };
    expect(bun.trustedDependencies).toEqual(['better-sqlite3']);
  });

  it('pins every @cogitator-ai package to the release of the scaffolder', () => {
    const pkg = JSON.parse(file(planProject(specFor('basic', 'openai')), 'package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(range, name).not.toBe('latest');
      if (name.startsWith('@cogitator-ai/')) expect(range, name).toMatch(/^\^\d+\.\d+\.\d+$/);
    }
  });

  it('quotes the project name instead of pasting it into code', () => {
    const plan = planProject(specFor('api-server', 'openai', { name: 'bob.s-agents' }));
    expect(syntaxErrors('src/index.ts', file(plan, 'src/index.ts'))).toEqual([]);
    expect(file(plan, 'src/index.ts')).toContain("title: 'bob.s-agents API'");
  });
});

describe('AGENTS.md', () => {
  it('keeps the Cogitator rules in a managed block and points CLAUDE.md at it', () => {
    const plan = planProject(specFor('basic', 'openai'));
    const agents = file(plan, 'AGENTS.md');
    expect(agents).toMatch(/^<!-- BEGIN:cogitator-agent-rules -->/);
    expect(agents).toContain('<!-- END:cogitator-agent-rules -->');
    expect(agents).toContain('node_modules/@cogitator-ai/core/docs/');
    expect(file(plan, 'CLAUDE.md')).toBe('@AGENTS.md\n');
  });

  it('adds the Next.js block next to its own in a Next.js app', () => {
    const agents = file(planProject(specFor('nextjs', 'openai')), 'AGENTS.md');
    expect(agents).toContain('<!-- BEGIN:nextjs-agent-rules -->');
    expect(agents).toContain('<!-- BEGIN:cogitator-agent-rules -->');
  });
});
