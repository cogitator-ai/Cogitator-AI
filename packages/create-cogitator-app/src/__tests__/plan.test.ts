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

  it('allows the native builds pnpm and Bun would otherwise skip, and declines the rest', () => {
    expect(file(planProject(specFor('memory', 'openai')), 'pnpm-workspace.yaml')).toBe(
      'allowBuilds:\n  better-sqlite3: true\n  cpu-features: false\n  esbuild: true\n  protobufjs: false\n  ssh2: false\n'
    );
    const bun = JSON.parse(
      file(planProject(specFor('memory', 'openai', { packageManager: 'bun' })), 'package.json')
    ) as {
      trustedDependencies?: string[];
    };
    expect(bun.trustedDependencies).toEqual(['better-sqlite3']);
    expect(file(planProject(specFor('basic', 'openai')), 'pnpm-workspace.yaml')).toBe(
      'allowBuilds:\n  better-sqlite3: false\n  cpu-features: false\n  esbuild: true\n  protobufjs: false\n  ssh2: false\n'
    );
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

describe('CI workflow', () => {
  const ci = (packageManagerSpec?: string) =>
    file(
      planProject(specFor('basic', 'openai', { packageManager: 'yarn' }), { packageManagerSpec }),
      '.github/workflows/ci.yml'
    );

  it('installs with the frozen-lockfile flag of the Yarn the project uses', () => {
    expect(ci('yarn@4.9.1')).toContain('- run: yarn install --immutable');
    expect(ci('yarn@1.22.22')).toContain('- run: yarn install --frozen-lockfile');
    expect(ci()).toContain('- run: yarn install --frozen-lockfile');
  });

  it('turns on corepack before setup-node, so the Yarn of package.json runs', () => {
    const workflow = ci('yarn@4.9.1');
    expect(workflow.indexOf('- run: corepack enable')).toBeGreaterThan(-1);
    expect(workflow.indexOf('- run: corepack enable')).toBeLessThan(
      workflow.indexOf('actions/setup-node')
    );
    expect(file(planProject(specFor('basic', 'openai')), '.github/workflows/ci.yml')).not.toContain(
      'corepack'
    );
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

describe('Cogitator Studio', () => {
  it.each(PRESETS.map((preset) => preset.id))(
    '%s opens with dev:studio and loads with tsx',
    (presetId) => {
      const plan = planProject(specFor(presetId, 'openai'));
      expect(plan.scripts['dev:studio']).toBe('cogitator dev');
      expect(plan.devDependencies.tsx).toBeDefined();
      expect(file(plan, 'README.md')).toContain('## Cogitator Studio');
      expect(file(plan, 'AGENTS.md')).toContain('dev:studio');
    }
  );
});

describe('coding agents', () => {
  it('configures the cogitator MCP server and skill where each agent looks', () => {
    const plan = planProject(
      specFor('workflow', 'openai', { codingAgents: ['claude', 'cursor', 'codex'] })
    );

    expect(JSON.parse(file(plan, '.mcp.json'))).toEqual({
      mcpServers: {
        cogitator: { type: 'stdio', command: 'pnpm', args: ['exec', 'cogitator', 'mcp'] },
      },
    });
    expect(JSON.parse(file(plan, '.cursor/mcp.json')).mcpServers.cogitator).toEqual({
      type: 'stdio',
      command: 'node',
      args: [
        '${workspaceFolder}/node_modules/@cogitator-ai/cli/dist/index.js',
        'mcp',
        '--project',
        '${workspaceFolder}',
      ],
    });
    expect(file(plan, '.codex/config.toml')).toContain(
      '[mcp_servers.cogitator]\ncommand = "pnpm"\nargs = ["exec", "cogitator", "mcp"]\n'
    );

    const skills = ['.claude/skills', '.cursor/skills', '.agents/skills'].map((dir) =>
      file(plan, `${dir}/cogitator/SKILL.md`)
    );
    expect(new Set(skills).size).toBe(1);
    expect(skills[0]).toMatch(/^---\nname: cogitator\ndescription: .+\n---\n/);
    expect(skills[0]).toContain('### Change a workflow');
    expect(skills[0]).not.toContain('### Change a swarm');
    expect(skills[0]).toContain('pnpm test');
    expect(file(plan, 'AGENTS.md')).toContain('## Coding agents');
  });

  it('starts the server with the project package manager', () => {
    const launch = (packageManager: 'npm' | 'yarn' | 'bun') =>
      JSON.parse(
        file(
          planProject(specFor('basic', 'openai', { packageManager, codingAgents: ['claude'] })),
          '.mcp.json'
        )
      ).mcpServers.cogitator;
    expect(launch('npm')).toMatchObject({ command: 'npx', args: ['--no', 'cogitator', 'mcp'] });
    expect(launch('yarn')).toMatchObject({ command: 'yarn', args: ['cogitator', 'mcp'] });
    expect(launch('bun')).toMatchObject({ command: 'bunx', args: ['cogitator', 'mcp'] });
  });

  it('writes nothing for coding agents without --agent', () => {
    const paths = planProject(specFor('basic', 'openai')).files.map((f) => f.path);
    expect(paths.filter((path) => /mcp\.json|config\.toml|SKILL\.md/.test(path))).toEqual([]);
  });
});

describe('preset file trees', () => {
  it.each(PRESETS.map((preset) => preset.id))('%s generates the expected files', (presetId) => {
    const preset = PRESETS.find((p) => p.id === presetId);
    const provider = preset?.spec.provider ?? 'openai';
    const paths = planProject(specFor(presetId, provider)).files.map((f) => f.path);
    expect(paths).toMatchSnapshot();
  });

  it('keeps --template working for every earlier template name', () => {
    for (const name of ['basic', 'memory', 'swarm', 'workflow', 'api-server', 'nextjs']) {
      expect(
        PRESETS.some((preset) => preset.id === name),
        name
      ).toBe(true);
    }
  });
});

describe('channels', () => {
  it('exports the gateway from src/gateway.ts, where the CLI looks for it, and starts it in src/index.ts', () => {
    const plan = planProject(
      parseSpec(
        specFor('channels', 'ollama', { channels: ['telegram', 'webchat'], memory: 'sqlite' })
      )
    );
    const gateway = file(plan, 'src/gateway.ts');
    expect(gateway).toMatch(/^export const gateway = new Gateway\(\{$/m);
    expect(gateway).toContain('telegramChannel(');
    expect(gateway).toContain('webchatChannel(');
    expect(gateway).toContain('const memory = await cogitator.getMemory();');
    expect(gateway).not.toContain('gateway.start()');

    const index = file(plan, 'src/index.ts');
    expect(index).toContain("import { gateway } from './gateway.js';");
    expect(index).toContain('await gateway.start();');
    expect(index).toContain('await gateway.stop();');
    expect(index).toContain('WEBCHAT_PORT');
  });

  it('runs the startup work of add-ons before the gateway exists', () => {
    const plan = planProject(
      parseSpec(specFor('channels', 'ollama', { channels: ['discord'], features: ['rag'] }))
    );
    const gateway = file(plan, 'src/gateway.ts');
    expect(gateway.indexOf('await knowledgeBase.ingest(DOCS_DIR);')).toBeGreaterThan(-1);
    expect(gateway.indexOf('await knowledgeBase.ingest(DOCS_DIR);')).toBeLessThan(
      gateway.indexOf('export const gateway')
    );
    expect(file(plan, 'src/index.ts')).not.toContain('loadEnv');
  });
});

describe('deploy', () => {
  it('writes no deploy artifacts without a target', () => {
    const paths = planProject(specFor('hono', 'openai')).files.map((f) => f.path);
    expect(paths).not.toContain('Dockerfile');
  });

  it('generates the production image with @cogitator-ai/deploy for Docker', () => {
    const plan = planProject(specFor('hono', 'openai', { deploy: 'docker' }));
    const dockerfile = file(plan, 'Dockerfile');
    expect(dockerfile).toContain('FROM base AS runtime');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('pnpm install --frozen-lockfile');
    expect(dockerfile).toContain('CMD ["node","dist/index.js"]');
    expect(dockerfile).toContain('http://127.0.0.1:3000/api/health');
    expect(file(plan, '.dockerignore')).toContain('.env');
    expect(plan.scripts['deploy:plan']).toBe('cogitator deploy --dry-run');
  });

  it('adds fly.toml with a volume for SQLite on Fly.io', () => {
    const plan = planProject(specFor('hono', 'openai', { deploy: 'fly' }));
    const fly = file(plan, 'fly.toml');
    expect(fly).toContain('[mounts]');
    expect(fly).toContain('path = "/api/health"');
    expect(file(plan, 'cogitator.yml')).toContain('target: fly');
  });

  it('runs a Tetsu image on Bun', () => {
    const dockerfile = file(
      planProject(specFor('tetsu', 'openai', { deploy: 'docker' })),
      'Dockerfile'
    );
    expect(dockerfile).toContain('FROM oven/bun:1-alpine AS base');
    expect(dockerfile).toContain('USER bun');
  });
});
