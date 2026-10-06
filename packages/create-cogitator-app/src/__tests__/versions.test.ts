import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTemplate, templateChoices } from '../templates/index.js';
import { cogitatorVersion, readCogitatorVersions } from '../templates/versions.js';

function workspaceVersion(dir: string): string {
  const pkg = JSON.parse(
    readFileSync(new URL(`../../../${dir}/package.json`, import.meta.url), 'utf-8')
  ) as { version: string };
  return pkg.version;
}

describe('@cogitator-ai dependency versions', () => {
  for (const { value } of templateChoices) {
    it(`${value} pins every @cogitator-ai package instead of using latest`, () => {
      const deps = getTemplate(value).dependencies();
      for (const [name, range] of Object.entries(deps)) {
        expect(range, name).not.toBe('latest');
        if (name.startsWith('@cogitator-ai/')) {
          const dir = name.slice('@cogitator-ai/'.length);
          expect(range, name).toBe(`^${workspaceVersion(dir)}`);
        }
      }
    });
  }

  it('resolves the version of the package being released, not a hardcoded one', () => {
    expect(cogitatorVersion('@cogitator-ai/core')).toBe(`^${workspaceVersion('core')}`);
  });
});

describe('readCogitatorVersions', () => {
  function packageRoot(manifest: object, linked: Record<string, string> = {}): string {
    const root = mkdtempSync(join(tmpdir(), 'cca-versions-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    for (const [name, version] of Object.entries(linked)) {
      const dir = join(root, 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
    }
    return root;
  }

  it('reads the ranges pnpm publish wrote into the published manifest', () => {
    const root = packageRoot({
      name: 'create-cogitator-app',
      devDependencies: { '@cogitator-ai/core': '^0.40.2', tsup: '^8.0.0' },
    });
    try {
      expect(readCogitatorVersions(root)).toEqual({ '@cogitator-ai/core': '^0.40.2' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('turns workspace ranges into a caret on the linked package version', () => {
    const root = packageRoot(
      {
        name: 'create-cogitator-app',
        devDependencies: {
          '@cogitator-ai/core': 'workspace:^',
          '@cogitator-ai/next': 'workspace:*',
        },
      },
      { '@cogitator-ai/core': '0.41.0', '@cogitator-ai/next': '0.9.3' }
    );
    try {
      expect(readCogitatorVersions(root)).toEqual({
        '@cogitator-ai/core': '^0.41.0',
        '@cogitator-ai/next': '^0.9.3',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails loudly when a workspace package cannot be found', () => {
    const root = packageRoot({
      name: 'create-cogitator-app',
      devDependencies: { '@cogitator-ai/core': 'workspace:^' },
    });
    try {
      expect(() => readCogitatorVersions(root)).toThrow(/@cogitator-ai\/core/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
