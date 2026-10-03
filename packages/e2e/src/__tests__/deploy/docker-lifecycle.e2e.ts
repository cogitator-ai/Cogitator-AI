import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Deployer } from '@cogitator-ai/deploy';

const describeDocker = process.env.TEST_DOCKER === 'true' ? describe : describe.skip;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 60_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return null;
}

describeDocker('deploy: docker lifecycle', () => {
  let projectDir: string;
  let port: number;
  const deployer = new Deployer();
  const appName = `cogitator-e2e-${process.pid}`;

  beforeAll(async () => {
    port = await freePort();
    projectDir = mkdtempSync(join(tmpdir(), 'cogitator-deploy-docker-'));
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ name: appName, version: '1.0.0', scripts: { start: 'node server.js' } })
    );
    writeFileSync(
      join(projectDir, 'server.js'),
      `const http = require('node:http');
http.createServer((req, res) => {
  if (req.url === '/cogitator/health') {
    res.end(JSON.stringify({ ok: true, secret: process.env.E2E_DEPLOY_SECRET ?? null }));
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(Number(process.env.PORT));
`
    );
    writeFileSync(join(projectDir, '.env'), 'E2E_DEPLOY_SECRET=from-dotenv\n');
  });

  afterAll(async () => {
    try {
      await deployer.destroy('docker', { port }, projectDir);
    } catch {
      spawnSync('docker', ['compose', '-p', appName, 'down'], { stdio: 'ignore' });
    }
    spawnSync('docker', ['image', 'rm', '-f', `${appName}:latest`], { stdio: 'ignore' });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('builds, starts, reports status and destroys a deployment', async () => {
    const result = await deployer.deploy({
      projectDir,
      target: 'docker',
      configOverrides: { port, secrets: ['E2E_DEPLOY_SECRET'] },
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.endpoints?.health).toBe(`http://localhost:${port}/cogitator/health`);

    const ignore = readFileSync(join(projectDir, '.dockerignore'), 'utf-8');
    expect(ignore).toContain('.env');
    expect(existsSync(join(projectDir, '.cogitator/docker-compose.prod.yml'))).toBe(true);

    const body = await waitForHealth(`http://localhost:${port}/cogitator/health`);
    expect(body).not.toBeNull();
    expect(JSON.parse(body ?? '{}')).toEqual({ ok: true, secret: 'from-dotenv' });

    const status = await deployer.status('docker', { port }, projectDir);
    expect(status.running).toBe(true);

    await deployer.destroy('docker', { port }, projectDir);
    const after = await deployer.status('docker', { port }, projectDir);
    expect(after.running).toBe(false);
  }, 300_000);
});
