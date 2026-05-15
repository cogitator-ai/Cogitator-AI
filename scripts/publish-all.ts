#!/usr/bin/env npx tsx

import { execFileSync } from 'child_process';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const REGISTRIES = ['https://registry.npmjs.org', 'https://npm.pkg.github.com'];

const packagesDir = join(process.cwd(), 'packages');

function getPublishablePackages(selectedPackages: string[]): string[] {
  const packages: string[] = [];

  for (const dir of readdirSync(packagesDir)) {
    const pkgPath = join(packagesDir, dir, 'package.json');
    if (!existsSync(pkgPath)) continue;

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (pkg.private) continue;

    if (
      selectedPackages.length === 0 ||
      selectedPackages.includes(dir) ||
      selectedPackages.includes(pkg.name)
    ) {
      packages.push(dir);
    }
  }

  return packages;
}

function publish(packageDir: string, registry: string): boolean {
  const pkgPath = join(packagesDir, packageDir);
  const pkg = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf-8'));

  console.log(`\n📦 Publishing ${pkg.name}@${pkg.version} to ${registry}`);

  try {
    execFileSync(
      'pnpm',
      ['publish', '--no-git-checks', '--access', 'public', '--registry', registry],
      {
        cwd: pkgPath,
        stdio: 'inherit',
      }
    );
    console.log(`✅ ${pkg.name} published to ${registry}`);
    return true;
  } catch {
    console.log(`⚠️  ${pkg.name} failed or already exists on ${registry}`);
    return false;
  }
}

async function main() {
  const packages = getPublishablePackages(process.argv.slice(2));

  console.log('🚀 Publishing packages to all registries...\n');
  console.log(`Packages: ${packages.join(', ')}`);
  console.log(`Registries: ${REGISTRIES.join(', ')}`);

  for (const pkg of packages) {
    for (const registry of REGISTRIES) {
      publish(pkg, registry);
    }
  }

  console.log('\n✨ Done!');
}

main();
