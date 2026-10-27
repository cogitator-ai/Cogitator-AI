import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { header, section } from '../_shared/setup.js';
import { LocalWorkspace, loadSandboxPolicy, workspaceTools } from '@cogitator-ai/core';
import { OsSandbox } from '@cogitator-ai/sandbox';
import type { WorkspaceExecResult } from '@cogitator-ai/types';

async function main() {
  header('08 - OS Sandbox: local commands under Seatbelt or bubblewrap');

  const availability = await OsSandbox.probe();
  if (!availability.available) {
    console.log(`  The OS sandbox cannot run here: ${availability.reason}`);
    console.log(
      '  macOS has sandbox-exec, Linux needs bubblewrap and socat (apt-get install bubblewrap socat).\n'
    );
    return;
  }

  const base = await mkdtemp(join(tmpdir(), 'cogitator-os-sandbox-'));
  const root = join(base, 'project');
  try {
    section('1. A sandbox policy from .claude/settings.json, as Claude Code writes it');
    await writeFile(join(base, 'outside.txt'), 'not yours');
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(
      join(root, '.claude', 'settings.json'),
      JSON.stringify(
        {
          sandbox: {
            enabled: true,
            filesystem: { denyRead: ['../outside.txt'] },
            network: { allowedDomains: ['registry.npmjs.org'] },
          },
        },
        null,
        2
      )
    );
    const { policy, warnings } = await loadSandboxPolicy(root);
    console.log(
      `  enabled: ${policy.enabled}, allowed domains: ${policy.network?.allowedDomains?.join(', ')}`
    );
    for (const warning of warnings) console.log(`  warning: ${warning}`);

    section(`2. A workspace whose commands run under ${availability.kind}`);
    const sandbox = new OsSandbox({ policy });
    const workspace = new LocalWorkspace({ root, exec: { sandbox } });
    await workspace.start();
    const [runCommand, deleteFile] = workspaceTools(workspace, {
      tools: ['run_command', 'delete_file'],
    });
    const context = { agentId: 'example', runId: 'example', signal: new AbortController().signal };
    const run = async (command: string) => {
      const result = (await runCommand.execute({ command }, context)) as WorkspaceExecResult;
      console.log(`  $ ${command}`);
      console.log(`    exit ${result.exitCode}, sandboxed: ${result.sandbox?.sandboxed}`);
      if (result.stdout) console.log(`    stdout: ${result.stdout.trim()}`);
      for (const violation of result.sandbox?.violations ?? []) {
        console.log(
          `    refused: ${violation.operation} ${violation.target} (${violation.reason})`
        );
      }
    };

    await run('echo built > build.txt && cat build.txt');
    await run(`echo overwrite > ${join(base, 'outside.txt')}`);
    await run(`cat ${join(base, 'outside.txt')}`);
    await run('echo "{}" > .claude/settings.json');
    await run('curl -s -m 5 -o /dev/null -w "%{http_code}" https://example.com');

    section('3. Deleting into the trash, and back');
    await deleteFile.execute({ path: 'build.txt' }, context);
    const [entry] = await workspace.listTrash();
    console.log(`  trashed ${entry.path} as ${entry.id}`);
    await workspace.restoreFromTrash(entry.id);
    console.log(`  restored: ${await workspace.read('build.txt')}`);

    await workspace.dispose();
    await sandbox.dispose();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
