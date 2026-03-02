import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGES_DIR = join(ROOT, 'packages');

const RELATIVE_IMPORT_RE = /(from\s+['"])(\.\.?\/[^'"]*?)(['"])/g;
const RELATIVE_REEXPORT_RE = /(export\s+\*\s+from\s+['"])(\.\.?\/[^'"]*?)(['"])/g;
const DYNAMIC_IMPORT_RE = /(import\s*\(\s*['"])(\.\.?\/[^'"]*?)(['"]\s*\))/g;

function walkDir(dir: string, ext: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...walkDir(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

function needsExtension(importPath: string, fileDir: string): boolean {
  if (importPath.endsWith('.js') || importPath.endsWith('.mjs') || importPath.endsWith('.json')) {
    return false;
  }

  const resolved = join(fileDir, importPath);
  if (existsSync(resolved + '.js')) return true;
  if (existsSync(resolved + '.mjs')) return true;
  if (
    existsSync(resolved) &&
    statSync(resolved).isDirectory() &&
    existsSync(join(resolved, 'index.js'))
  ) {
    return true;
  }
  return false;
}

function resolveExtension(importPath: string, fileDir: string): string {
  const resolved = join(fileDir, importPath);
  if (existsSync(resolved + '.js')) return importPath + '.js';
  if (existsSync(resolved + '.mjs')) return importPath + '.mjs';
  if (
    existsSync(resolved) &&
    statSync(resolved).isDirectory() &&
    existsSync(join(resolved, 'index.js'))
  ) {
    return importPath + '/index.js';
  }
  return importPath;
}

function fixFile(filePath: string): boolean {
  const fileDir = join(filePath, '..');
  const original = readFileSync(filePath, 'utf-8');

  const fixer = (_match: string, prefix: string, importPath: string, suffix: string) => {
    if (needsExtension(importPath, fileDir)) {
      return prefix + resolveExtension(importPath, fileDir) + suffix;
    }
    return prefix + importPath + suffix;
  };

  let content = original;
  content = content.replace(RELATIVE_IMPORT_RE, fixer);
  content = content.replace(RELATIVE_REEXPORT_RE, fixer);
  content = content.replace(DYNAMIC_IMPORT_RE, fixer);

  if (content !== original) {
    writeFileSync(filePath, content);
    return true;
  }
  return false;
}

const packages = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

let totalFixed = 0;
let totalFiles = 0;

for (const pkg of packages) {
  const distDir = join(PACKAGES_DIR, pkg, 'dist');
  if (!existsSync(distDir)) continue;

  const jsFiles = walkDir(distDir, '.js');
  const dtsFiles = walkDir(distDir, '.d.ts');
  const allFiles = [...jsFiles, ...dtsFiles];

  for (const file of allFiles) {
    totalFiles++;
    if (fixFile(file)) {
      totalFixed++;
    }
  }
}

console.log(`Fixed ${totalFixed}/${totalFiles} files across ${packages.length} packages`);
