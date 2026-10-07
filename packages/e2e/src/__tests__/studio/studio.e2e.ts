import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { findPreset, scaffold } from 'create-cogitator-app';
import { startFakeOllama, type FakeMessage, type FakeOllama } from '../../helpers/fake-ollama';
import {
  cogitatorDependencies,
  installArgs,
  mustExec,
  packWorkspace,
  useTarballs,
} from '../../helpers/scaffold-harness';

/**
 * Cogitator Studio on a project create-cogitator-app generated, installed
 * from the workspace tarballs, with a scripted Ollama standing in for the
 * model. A browser chats with the assistant, approves a file write, opens
 * the trace and forks a run with a changed tool result.
 */
const root = mkdtempSync(join(tmpdir(), 'studio-e2e-'));
const dir = join(root, 'studio-e2e');
let model: FakeOllama;
let studio: ChildProcess;
let browser: Browser;
let page: Page;
let url = '';
const output: string[] = [];

function reply(messages: FakeMessage[]) {
  const last = messages.at(-1);
  if (last?.role === 'tool') return { content: `Result: ${last.content}` };
  const input = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  if (input.includes('note')) {
    return {
      toolCalls: [
        { name: 'file_write', arguments: { path: 'note.md', content: 'hello from the studio' } },
      ],
    };
  }
  if (input.includes('calculate'))
    return { toolCalls: [{ name: 'calculator', arguments: { expression: '6 * 7' } }] };
  return { content: `Hello: ${input}`, thinking: 'The user greets me.' };
}

beforeAll(async () => {
  model = await startFakeOllama(reply);
  const preset = findPreset('assistant');
  if (!preset) throw new Error('no assistant preset');
  await scaffold(
    {
      name: 'studio-e2e',
      preset: 'assistant',
      ...preset.spec,
      provider: 'ollama',
      model: 'qwen3.5:4b',
      packageManager: 'pnpm',
    },
    { directory: dir, install: false, git: false }
  );
  useTarballs(dir, 'pnpm', await packWorkspace(cogitatorDependencies(dir)));
  await mustExec('pnpm', installArgs('pnpm'), { cwd: dir });

  studio = spawn('pnpm', ['exec', 'cogitator', 'dev', '--port', '0', '--no-open', '--no-watch'], {
    cwd: dir,
    env: { ...process.env, OLLAMA_BASE_URL: model.url, CI: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the studio did not start:\n${output.join('')}`)),
      60_000
    );
    const read = (chunk: Buffer) => {
      output.push(chunk.toString());
      const found = /(http:\/\/localhost:\d+\/)/.exec(output.join(''));
      if (found) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    };
    studio.stdout?.on('data', read);
    studio.stderr?.on('data', read);
    studio.once('exit', (code) =>
      reject(new Error(`the studio exited with ${code}:\n${output.join('')}`))
    );
  });
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(url);
  await page.getByTestId('agent-assistant').waitFor({ timeout: 60_000 });
}, 600_000);

afterAll(async () => {
  await browser?.close();
  studio?.kill('SIGTERM');
  await model?.close();
  rmSync(root, { recursive: true, force: true });
});

/** Sends a message and waits for its turn to appear. */
async function send(text: string): Promise<void> {
  const turns = await page.getByTestId('turn').count();
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('send').click();
  await expect.poll(() => page.getByTestId('turn').count(), { timeout: 30_000 }).toBe(turns + 1);
}

describe('Cogitator Studio on a generated project', () => {
  it('chats with the assistant, streaming the answer and the reasoning', async () => {
    await page.getByTestId('agent-assistant').click();
    await send('hi there');
    const turn = page.getByTestId('turn').last();
    await expect
      .poll(() => turn.getAttribute('data-status'), { timeout: 30_000 })
      .toBe('completed');
    expect(await turn.getByTestId('answer').innerText()).toContain('Hello: hi there');
    expect(await turn.innerText()).toContain('reasoning');
  });

  it('waits for approval of a file write and writes it once approved', async () => {
    await send('save a note');
    const approval = page.getByTestId('approval');
    await approval.waitFor({ timeout: 30_000 });
    expect(await page.getByTestId('tool-call').last().innerText()).toContain('note.md');
    expect(existsSync(join(dir, 'workspace', 'note.md'))).toBe(false);

    await page.getByTestId('approve').click();
    const turn = page.getByTestId('turn').last();
    await expect
      .poll(() => turn.getAttribute('data-status'), { timeout: 30_000 })
      .toBe('completed');
    expect(readFileSync(join(dir, 'workspace', 'note.md'), 'utf-8')).toBe('hello from the studio');
    expect(await turn.getByTestId('answer').innerText()).toContain('Result:');
  });

  it('shows the trace and forks the run with a changed tool result', async () => {
    await send('calculate the answer');
    const turn = page.getByTestId('turn').last();
    await expect
      .poll(() => turn.getAttribute('data-status'), { timeout: 30_000 })
      .toBe('completed');
    expect(await turn.getByTestId('answer').innerText()).toContain('42');

    await turn.getByTestId('trace-link').click();
    await page.getByTestId('waterfall').waitFor();
    const rows = await page.locator('.waterfall-row').allInnerTexts();
    expect(rows.some((row) => row.includes('tool calculator'))).toBe(true);
    expect(rows.filter((row) => row.includes('model')).length).toBe(2);

    await page.getByTestId('step-0').click();
    await page.getByTestId('fork-result-calculator').fill('41');
    await page.getByTestId('fork').click();

    await page.getByTestId('compare-view').waitFor({ timeout: 30_000 });
    const fork = page.getByTestId('compare-fork');
    await expect
      .poll(() => fork.getByTestId('compare-output').innerText(), { timeout: 30_000 })
      .toContain('Result: 41');
    expect(
      await page.getByTestId('compare-original').getByTestId('compare-output').innerText()
    ).toContain('42');
  });

  it('keeps the runs in the history', async () => {
    await page.getByTestId('nav-runs').click();
    await expect
      .poll(() => page.getByTestId('run-row').count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(4);
    await page.getByTestId('search').fill('calculate');
    await expect.poll(() => page.getByTestId('run-row').count(), { timeout: 10_000 }).toBe(2);
  });
});
