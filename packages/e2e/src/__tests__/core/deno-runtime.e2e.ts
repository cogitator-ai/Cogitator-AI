import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hasDeno = spawnSync('deno', ['--version']).status === 0;
const describeDeno = hasDeno && process.env.GOOGLE_API_KEY ? describe : describe.skip;

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const PORT = 3195;
const base = `http://127.0.0.1:${PORT}/cogitator`;

async function waitForHealth(server: ChildProcess, output: () => string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`Deno exited early:\n${output()}`);
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Deno server did not start:\n${output()}`);
}

describeDeno('Core: Deno runtime', () => {
  let server: ChildProcess;
  let output = '';

  beforeAll(async () => {
    server = spawn(
      'deno',
      [
        'run',
        '--no-prompt',
        '--allow-net',
        '--allow-env=GOOGLE_API_KEY,PORT',
        'examples/integrations/09-deno-server.ts',
      ],
      { cwd: repoRoot, env: { ...process.env, PORT: String(PORT) } }
    );
    server.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    server.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    await waitForHealth(server, () => output);
  }, 90_000);

  afterAll(() => {
    server?.kill('SIGKILL');
  });

  it(
    'runs an agent with a tool under Deno with only network and env access',
    { timeout: 120_000 },
    async () => {
      const response = await fetch(`${base}/agents/assistant/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'Use the calculator: what is 123 * 456?' }),
      });
      const result = (await response.json()) as {
        output: string;
        toolCalls: Array<{ name: string }>;
      };

      expect(response.status).toBe(200);
      expect(result.toolCalls.map((call) => call.name)).toContain('calculator');
      expect(result.output.replace(/[,\s]/g, '')).toContain('56088');
    }
  );

  it('streams the run as server-sent events', { timeout: 120_000 }, async () => {
    const response = await fetch(`${base}/agents/assistant/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Say hello in three words.' }),
    });
    const events = await response.text();

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(events).toContain('"type":"text-delta"');
    expect(events).toContain('"type":"finish"');
  });
});
