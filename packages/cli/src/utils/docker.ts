import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

export function findDockerCompose(): string | null {
  for (const name of ['docker-compose.yml', 'docker-compose.yaml']) {
    if (existsSync(name)) return resolve(name);
  }

  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
    for (const name of ['docker-compose.yml', 'docker-compose.yaml']) {
      const full = resolve(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

export function checkDocker(): boolean {
  try {
    execSync('docker --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
