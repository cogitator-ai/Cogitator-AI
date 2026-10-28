import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalWorkspace } from '@cogitator-ai/core';
import { acpProviders } from '../commands/app-server';
import { createProgram } from '../program';

let dir: string;
let workspace: LocalWorkspace;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-acp-'));
  workspace = new LocalWorkspace({ root: dir });
});

afterEach(async () => {
  await workspace.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('cogitator acp', () => {
  it('is a command of the CLI with its options', () => {
    const acp = createProgram().commands.find((command) => command.name() === 'acp');
    expect(acp?.options.map((option) => option.long)).toEqual([
      '--config',
      '--model',
      '--models',
      '--trust',
      '--no-session-persistence',
    ]);
  });

  it('names the external agents of --acp-agent by preset, by name=spec or by command', async () => {
    const external = await acpProviders(
      ['claude', 'mine=./agent --acp', 'my-agent --stdio'],
      workspace
    );
    expect(Object.keys(external.providers)).toEqual(['claude', 'mine', 'my-agent']);
    expect(external.providers.claude?.description).toBe('Claude Code, an external ACP agent');
    await external.close();
    await expect(acpProviders(['codex', 'codex'], workspace)).rejects.toThrow(/Two ACP agents/);
  });
});
