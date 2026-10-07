import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { c as createTar } from 'tar';
import {
  exampleFileUrl,
  exampleRef,
  examples,
  findExample,
  parseExampleArgument,
  planExample,
} from '../kit/examples.js';
import { downloadTemplate, prepareTemplate, templateArchive } from '../kit/remote.js';
import { createFromExample, createFromTemplate, resolveExample } from '../kit/starter.js';
import { scaffolderVersion } from '../kit/versions.js';
import { run } from '../cli/main.js';

const EXAMPLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../examples');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cca-starter-'));
  roots.push(root);
  return root;
}

/** GitHub as far as the examples go: raw files served from the local examples/. */
function rawGithub(requests: string[] = []): typeof fetch {
  return async (input) => {
    const url = String(input);
    requests.push(url);
    const match = /\/examples\/(.+)$/.exec(url);
    const file = match ? join(EXAMPLES_DIR, match[1]) : '';
    if (!file || !existsSync(file)) return new Response('Not Found', { status: 404 });
    return new Response(readFileSync(file, 'utf-8'));
  };
}

describe('the examples index', () => {
  it('covers the runnable examples of the repo with their files and packages', () => {
    const index = examples();
    expect(index.length).toBeGreaterThan(50);
    const basic = findExample('core/basic-agent');
    expect(basic).toMatchObject({
      entry: 'core/01-basic-agent.ts',
      title: 'Basic Agent with Custom Tools',
      runtime: 'node',
    });
    expect(basic.files).toEqual(['_shared/setup.ts', 'core/01-basic-agent.ts']);
    expect(Object.keys(basic.dependencies)).toEqual(['@cogitator-ai/core', 'dotenv', 'zod']);
    expect(basic.env).toContain('GOOGLE_API_KEY');
    for (const example of index) {
      for (const file of example.files)
        expect(existsSync(join(EXAMPLES_DIR, file)), file).toBe(true);
    }
  });

  it('finds an example by name, file or short name and suggests on a typo', () => {
    expect(findExample('core/01-basic-agent.ts').name).toBe('core/basic-agent');
    expect(findExample('basic-agent').name).toBe('core/basic-agent');
    expect(() => findExample('core/basic-agnt')).toThrow('Did you mean "core/basic-agent"?');
    expect(parseExampleArgument('core/basic-agent#main')).toEqual({
      query: 'core/basic-agent',
      ref: 'main',
    });
  });

  it('pins the tag of the scaffolder version and the raw URL GitHub serves', () => {
    expect(exampleRef('0.5.0')).toBe('create-cogitator-app@0.5.0');
    expect(exampleFileUrl('create-cogitator-app@0.5.0', 'core/01-basic-agent.ts')).toBe(
      'https://raw.githubusercontent.com/cogitator-ai/Cogitator-AI/create-cogitator-app@0.5.0/examples/core/01-basic-agent.ts'
    );
  });
});

describe('--example', () => {
  it('plans a project around the example that runs it with tsx', () => {
    const plan = planExample(findExample('core/basic-agent'), {
      name: 'tutor',
      packageManager: 'pnpm',
      version: '0.5.0',
      ref: 'create-cogitator-app@0.5.0',
    });
    const manifest = JSON.parse(
      plan.files.find((file) => file.path === 'package.json')?.content ?? '{}'
    );
    expect(manifest.scripts.start).toBe('tsx --env-file-if-exists=.env src/core/01-basic-agent.ts');
    expect(manifest.dependencies['@cogitator-ai/core']).toMatch(/^\^\d/);
    expect(manifest.devDependencies).toHaveProperty('tsx');
    expect(manifest.cogitator.example).toEqual({
      name: 'core/basic-agent',
      ref: 'create-cogitator-app@0.5.0',
    });
    expect(plan.files.find((file) => file.path === '.env.example')?.content).toContain(
      'GOOGLE_API_KEY='
    );
    expect(plan.files.find((file) => file.path === 'pnpm-workspace.yaml')?.content).toContain(
      'esbuild: true'
    );
  });

  it('runs a Bun example with Bun', () => {
    const plan = planExample(findExample('integrations/tetsu-server'), {
      name: 'tetsu',
      packageManager: 'bun',
      version: '0.5.0',
      ref: 'main',
    });
    const manifest = JSON.parse(
      plan.files.find((file) => file.path === 'package.json')?.content ?? '{}'
    );
    expect(manifest.scripts.start).toBe('bun src/integrations/08-tetsu-server.ts');
    expect(manifest.devDependencies).not.toHaveProperty('tsx');
    expect(manifest.devDependencies).toHaveProperty('@types/bun');
  });

  it('downloads the example files at the tag and writes the project', async () => {
    const requests: string[] = [];
    const directory = join(tempRoot(), 'tutor');
    const plan = resolveExample('core/basic-agent', { name: 'tutor', packageManager: 'pnpm' });
    const result = await createFromExample(plan, {
      directory,
      name: 'tutor',
      packageManager: 'pnpm',
      install: false,
      git: false,
      fetch: rawGithub(requests),
    });

    expect(
      requests.every((url) =>
        url.includes(`/create-cogitator-app@${scaffolderVersion()}/examples/`)
      )
    ).toBe(true);
    expect(readFileSync(join(directory, 'src/core/01-basic-agent.ts'), 'utf-8')).toBe(
      readFileSync(join(EXAMPLES_DIR, 'core/01-basic-agent.ts'), 'utf-8')
    );
    expect(existsSync(join(directory, 'src/_shared/setup.ts'))).toBe(true);
    expect(result.source).toBe(
      `example core/basic-agent at create-cogitator-app@${scaffolderVersion()}`
    );
    expect(result.nextSteps.map((step) => step.command)).toContain('pnpm dev');
  });

  it('explains a ref that has no such example', async () => {
    const plan = resolveExample('core/basic-agent#v0.0.1', {
      name: 'tutor',
      packageManager: 'pnpm',
    });
    await expect(
      createFromExample(plan, {
        directory: join(tempRoot(), 'tutor'),
        name: 'tutor',
        packageManager: 'pnpm',
        install: false,
        git: false,
        fetch: async () => new Response('Not Found', { status: 404 }),
      })
    ).rejects.toThrow('Pass --example core/basic-agent#main for the main branch');
  });
});

/** A GitHub archive: everything under one top directory, the way codeload serves it. */
async function archive(build: (root: string) => void): Promise<Buffer> {
  const staging = tempRoot();
  const top = 'acme-templates-1a2b3c4';
  mkdirSync(join(staging, top), { recursive: true });
  build(join(staging, top));
  const file = join(staging, 'archive.tgz');
  await createTar({ gzip: true, file, cwd: staging, portable: true }, [top]);
  return readFileSync(file);
}

function serve(body: Buffer, requests: string[] = []): typeof fetch {
  return async (input) => {
    requests.push(String(input));
    return new Response(new Uint8Array(body), {
      headers: { 'content-length': String(body.length) },
    });
  };
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

describe('github: templates', () => {
  it('extracts a directory of the repository, leaving links out', async () => {
    const body = await archive((root) => {
      write(root, 'README.md', '# all templates');
      write(
        root,
        'bots/support/package.json',
        JSON.stringify({ name: 'support', dependencies: { '@cogitator-ai/core': 'workspace:*' } })
      );
      write(root, 'bots/support/src/index.ts', 'export {};\n');
      write(root, 'bots/other/package.json', '{}');
      symlinkSync('/etc/passwd', join(root, 'bots/support/passwd'));
    });
    const requests: string[] = [];
    const directory = join(tempRoot(), 'bot');

    const result = await downloadTemplate(
      { owner: 'acme', repo: 'templates', path: 'bots/support', ref: 'v2' },
      directory,
      { fetch: serve(body, requests) }
    );

    expect(requests).toEqual(['https://codeload.github.com/acme/templates/tar.gz/v2']);
    expect(result.files).toEqual(['package.json', 'src/index.ts']);
    expect(result.skipped).toEqual(['passwd']);
    expect(existsSync(join(directory, 'passwd'))).toBe(false);
    expect(existsSync(join(directory, 'README.md'))).toBe(false);
    expect(statSync(join(directory, 'src/index.ts')).isFile()).toBe(true);

    const prepared = prepareTemplate(directory, { name: 'bot' });
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf-8'));
    expect(manifest.name).toBe('bot');
    expect(manifest.dependencies['@cogitator-ai/core']).toMatch(/^\^\d/);
    expect(prepared.rewritten).toEqual(['@cogitator-ai/core']);
  });

  it('goes through the GitHub API with a token, for private repositories', () => {
    expect(templateArchive({ owner: 'acme', repo: 'private' }, 'ghp_x')).toEqual({
      url: 'https://api.github.com/repos/acme/private/tarball/',
      headers: { authorization: 'Bearer ghp_x', accept: 'application/vnd.github+json' },
    });
  });

  it('refuses packages of the template monorepo and leaves nothing behind', async () => {
    const body = await archive((root) => {
      write(
        root,
        'package.json',
        JSON.stringify({
          name: 'x',
          dependencies: { '@acme/ui': 'workspace:*', lodash: 'catalog:' },
        })
      );
    });
    const directory = join(tempRoot(), 'bot');

    await expect(
      createFromTemplate(
        { owner: 'acme', repo: 'templates' },
        {
          directory,
          name: 'bot',
          packageManager: 'pnpm',
          install: false,
          git: false,
          fetch: serve(body),
        }
      )
    ).rejects.toThrow('@acme/ui@workspace:*, lodash@catalog:');
    expect(existsSync(directory)).toBe(false);
  });

  it('names a missing repository, path or ref', async () => {
    const notFound: typeof fetch = async () => new Response('', { status: 404 });
    await expect(
      downloadTemplate({ owner: 'acme', repo: 'nope' }, join(tempRoot(), 'x'), { fetch: notFound })
    ).rejects.toThrow(
      'github:acme/nope was not found: check the repository and the ref, and set GITHUB_TOKEN'
    );
    const body = await archive((root) => write(root, 'package.json', '{}'));
    await expect(
      downloadTemplate(
        { owner: 'acme', repo: 'templates', path: 'missing' },
        join(tempRoot(), 'y'),
        { fetch: serve(body) }
      )
    ).rejects.toThrow('has no files under missing');
  });
});

describe('the CLI with starters', () => {
  async function cli(argv: string[], fetcher: typeof fetch) {
    let stdout = '';
    let stderr = '';
    const code = await run(
      argv,
      { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) },
      { fetch: fetcher }
    );
    return { code, stdout, stderr };
  }

  it('lists the examples', async () => {
    const { code, stdout } = await cli(['--list-examples', '--json'], rawGithub());
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toContainEqual(
      expect.objectContaining({ name: 'core/basic-agent', entry: 'core/01-basic-agent.ts' })
    );
  });

  it('creates a project from an example without asking anything', async () => {
    const directory = join(tempRoot(), 'tutor');
    const { code, stdout } = await cli(
      [directory, '--example', 'core/basic-agent', '--json', '--no-install', '--no-git'],
      rawGithub()
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.files).toContain('src/core/01-basic-agent.ts');
    expect(existsSync(join(directory, 'src/core/01-basic-agent.ts'))).toBe(true);
  });

  it('refuses stack flags an example cannot take', async () => {
    const { code, stderr } = await cli(
      [join(tempRoot(), 'x'), '--example', 'core/basic-agent', '--memory', 'postgres', '--yes'],
      rawGithub()
    );
    expect(code).toBe(1);
    expect(stderr).toContain('--memory do not apply');
  });
});
