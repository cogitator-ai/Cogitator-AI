import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { getTemplate, templateChoices } from '../templates/index.js';
import { generateGitignore } from '../templates/base/gitignore.js';
import type { LLMProvider, ProjectOptions, Template, TemplateFile } from '../types.js';

const SCRIPT_TEMPLATES = ['basic', 'memory', 'swarm', 'workflow', 'api-server'] as const;
const PROVIDERS: LLMProvider[] = ['ollama', 'openai', 'anthropic', 'google'];

function options(template: Template, overrides: Partial<ProjectOptions> = {}): ProjectOptions {
  return {
    name: 'test-project',
    path: '/tmp/test-project',
    template,
    provider: 'ollama',
    packageManager: 'pnpm',
    docker: false,
    git: false,
    ...overrides,
  };
}

function fileOf(files: TemplateFile[], path: string): string {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`template did not generate ${path}`);
  return file.content;
}

function syntaxErrors(file: TemplateFile): string[] {
  const result = ts.transpileModule(file.content, {
    fileName: file.path,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 },
  });
  return (result.diagnostics ?? []).map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, '\n')
  );
}

describe('generated code is valid TypeScript', () => {
  for (const { value: template } of templateChoices) {
    for (const provider of PROVIDERS) {
      it(`${template} with ${provider} parses`, () => {
        for (const file of getTemplate(template).files(options(template, { provider }))) {
          if (!/\.tsx?$/.test(file.path)) continue;
          expect(syntaxErrors(file), file.path).toEqual([]);
        }
      });
    }

    it(`${template} quotes the project name instead of pasting it into code`, () => {
      const name = "bob's {agents} </h1> \\ `x`";
      for (const file of getTemplate(template).files(options(template, { name }))) {
        if (!/\.tsx?$/.test(file.path)) continue;
        expect(syntaxErrors(file), file.path).toEqual([]);
      }
    });
  }
});

describe('environment loading', () => {
  for (const template of SCRIPT_TEMPLATES) {
    it(`${template} loads .env in its dev and start scripts`, () => {
      const scripts = getTemplate(template).scripts();
      expect(scripts.dev).toBe('tsx watch --env-file-if-exists=.env src/index.ts');
      expect(scripts.start).toBe('tsx --env-file-if-exists=.env src/index.ts');
    });

    it(`${template} names the missing key and .env.example instead of asserting it is set`, () => {
      const files = getTemplate(template).files(options(template, { provider: 'openai' }));
      const all = files.map((f) => f.content).join('\n');
      expect(all).not.toContain('process.env.OPENAI_API_KEY!');
      expect(all).toContain("requireEnv('OPENAI_API_KEY')");
      expect(fileOf(files, 'src/env.ts')).toContain('.env.example');
    });

    it(`${template} needs no env helper for a local Ollama`, () => {
      const files = getTemplate(template).files(options(template));
      expect(files.map((f) => f.path)).not.toContain('src/env.ts');
    });
  }
});

describe('failures exit non-zero', () => {
  for (const template of SCRIPT_TEMPLATES) {
    it(`${template} sets a failing exit code when main() rejects`, () => {
      const indexTs = fileOf(getTemplate(template).files(options(template)), 'src/index.ts');
      expect(indexTs).not.toContain('main().catch(console.error)');
      expect(indexTs).toContain('process.exitCode = 1');
    });
  }

  it('workflow fails when the workflow result carries an error', () => {
    const indexTs = fileOf(getTemplate('workflow').files(options('workflow')), 'src/index.ts');
    expect(indexTs).toContain('if (result.error) throw result.error');
  });

  it('memory and swarm close their resources when the run fails', () => {
    const memory = fileOf(getTemplate('memory').files(options('memory')), 'src/index.ts');
    expect(memory).toMatch(/finally \{\n\s+await cogitator\.close\(\)/);
    const swarm = fileOf(getTemplate('swarm').files(options('swarm')), 'src/index.ts');
    expect(swarm).toMatch(/finally \{\n\s+await team\.close\(\)/);
  });
});

describe('workflow output', () => {
  it('prints node results as an object, since JSON.stringify turns a Map into {}', () => {
    const indexTs = fileOf(getTemplate('workflow').files(options('workflow')), 'src/index.ts');
    expect(indexTs).toContain('Object.fromEntries(result.nodeResults)');
    expect(indexTs).not.toContain('JSON.stringify(result, null, 2)');
  });
});

describe('chat templates keep the conversation', () => {
  it('api-server configures memory, so threads persist and thread routes answer', () => {
    const indexTs = fileOf(getTemplate('api-server').files(options('api-server')), 'src/index.ts');
    expect(indexTs).toContain("memory: { adapter: 'memory' }");
  });

  it('nextjs configures memory, so the next message sees the previous ones', () => {
    const agentTs = fileOf(getTemplate('nextjs').files(options('nextjs')), 'src/lib/agent.ts');
    expect(agentTs).toContain("memory: { adapter: 'memory' }");
  });
});

describe('api-server exposure', () => {
  const indexTs = fileOf(getTemplate('api-server').files(options('api-server')), 'src/index.ts');

  it('does not allow every origin', () => {
    expect(indexTs).not.toContain("origin: '*'");
    expect(indexTs).toContain('process.env.CORS_ORIGIN');
  });

  it('listens on loopback unless HOST says otherwise or it runs in production', () => {
    expect(indexTs).toContain("'127.0.0.1'");
    expect(indexTs).toMatch(/app\.listen\(port, host/);
  });

  it('checks a bearer API_TOKEN and refuses to start in production without one', () => {
    expect(indexTs).toContain('process.env.API_TOKEN');
    expect(indexTs).toContain('auth: authenticate');
    expect(indexTs).toMatch(/production && !apiToken/);
  });
});

describe('nextjs template', () => {
  it('has no next lint script, which prompts in CI and is gone in Next 16', () => {
    const scripts = getTemplate('nextjs').scripts();
    expect(Object.values(scripts)).not.toContain('next lint');
    expect(scripts.typecheck).toBe('tsc --noEmit');
  });

  it('shows run errors and lets the user stop a reply', () => {
    const page = fileOf(getTemplate('nextjs').files(options('nextjs')), 'src/app/page.tsx');
    expect(page).toMatch(/const \{[^}]*\berror\b[^}]*\} = useCogitatorChat/);
    expect(page).toContain('{error && (');
    expect(page).toContain('error.message');
    expect(page).toContain('onClick={stop}');
  });
});

describe('gitignore', () => {
  it('ignores every local env file but keeps .env.example', () => {
    const lines = generateGitignore('basic').content.split('\n');
    expect(lines).toContain('.env');
    expect(lines).toContain('.env.*');
    expect(lines).toContain('!.env.example');
    expect(lines).toContain('*.tsbuildinfo');
  });

  it('ignores the Next.js build output for the nextjs template', () => {
    const lines = generateGitignore('nextjs').content.split('\n');
    expect(lines).toEqual(expect.arrayContaining(['.next/', 'out/', 'next-env.d.ts']));
  });

  it('leaves Next.js entries out of the other templates', () => {
    expect(generateGitignore('basic').content).not.toContain('.next/');
  });
});
