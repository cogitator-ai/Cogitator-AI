import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  experimental_definePlugin,
  experimental_memorySecretStore,
  type Tool,
} from '@cogitator-ai/core';
import { createCogitator, header, section } from '../_shared/setup.js';

const MODEL = process.env.EXAMPLE_MODEL ?? `ollama/${process.env.OLLAMA_MODEL ?? 'qwen2.5:0.5b'}`;

/** Writes `files` under `dir`, each path relative to it */
function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** A plugin in Claude Code's format, as a Claude Code user would write it: a command and a skill */
function claudeCodePlugin(dir: string): void {
  write(dir, {
    '.claude-plugin/plugin.json': JSON.stringify({
      name: 'release-notes',
      version: '1.0.0',
      description: 'Writes release notes',
      userConfig: {
        product: {
          type: 'string',
          title: 'Product',
          description: 'Product name',
          default: 'Cogitator',
        },
      },
    }),
    'commands/notes.md':
      '---\ndescription: Release notes for a version\nargument-hint: [version]\n---\nWrite one sentence of release notes for ${user_config.product} version $0. Mention the version.\n',
    'skills/tone/SKILL.md':
      '---\nname: tone\ndescription: How release notes sound. Use when writing release notes.\n---\nKeep it short and friendly.\n',
  });
}

/** A plugin with code: it runs in a process of its own, allowed to read only ./public/** */
function isolatedPlugin(dir: string): void {
  write(dir, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'reader', version: '1.0.0' }),
    '.cogitator-plugin/plugin.json': JSON.stringify({
      main: './main.mjs',
      permissions: { allow: ['Read(./public/**)'] },
    }),
    'main.mjs': `export default {
  name: 'reader',
  activate(context) {
    context.registerTool({
      name: 'read_project_file',
      description: 'Reads a file of the project',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async ({ path }) => {
        try {
          return await context.files.readFile(path);
        } catch (error) {
          return 'refused: ' + error.message;
        }
      },
    });
  },
};
`,
  });
}

const helpers = experimental_definePlugin({
  name: 'helpers',
  version: '1.0.0',
  activate(context) {
    context.registerTool({
      name: 'today',
      description: 'The date today',
      parameters: { type: 'object', properties: {} },
      readOnly: true,
      execute: async () => new Date().toISOString().slice(0, 10),
    });
    context.onDispose(() => console.log('  helpers unloaded'));
  },
});

async function call(tool: Tool | undefined, args: Record<string, unknown>): Promise<unknown> {
  return tool?.execute(args, {
    agentId: 'example',
    runId: 'example',
    signal: new AbortController().signal,
  });
}

async function main() {
  header('32 - Plugins: Claude Code plugins, plugins in code, isolation and hot reload');
  const dir = mkdtempSync(join(tmpdir(), 'cogitator-plugins-'));
  const project = join(dir, 'project');
  write(project, { 'public/readme.txt': 'Public notes', 'secret.txt': 'Do not read me' });
  claudeCodePlugin(join(dir, 'release-notes'));
  isolatedPlugin(join(dir, 'reader'));

  const cog = createCogitator({
    experimental_plugins: {
      plugins: [helpers],
      dirs: [join(dir, 'release-notes'), join(dir, 'reader')],
      installed: false,
      settings: { root: project, userDirs: [], managedDirs: [] },
      secrets: experimental_memorySecretStore(),
    },
  });

  try {
    section('1. What the plugins add');
    await cog.experimental_plugins.load();
    for (const plugin of cog.experimental_plugins.list()) {
      const { tools, skills, commands, llmBackends } = plugin.contributions;
      console.log(
        `  ${plugin.id} ${plugin.status} gen ${plugin.generation}${plugin.isolated ? ' (own process)' : ''}`,
        JSON.stringify({ tools, skills, commands, llmBackends: llmBackends.length })
      );
    }

    section('2. A Claude Code command, on a real model');
    const agent = new Agent({
      name: 'writer',
      model: MODEL,
      instructions: 'You write release notes.',
      temperature: 0,
    });
    const result = await cog.run(agent, { input: '/release-notes:notes 2.4.0' });
    console.log(`  command: ${result.command?.name}, from ${result.command?.plugin}`);
    console.log(`  output:  ${result.output.trim()}`);

    section('3. The isolated plugin asks the host, its permissions decide');
    const reader = cog.experimental_plugins
      .snapshot()
      .tools.find((tool) => tool.name === 'read_project_file');
    console.log(
      `  public/readme.txt -> ${String(await call(reader, { path: 'public/readme.txt' }))}`
    );
    console.log(`  secret.txt        -> ${String(await call(reader, { path: 'secret.txt' }))}`);

    section('4. Hot reload: a broken generation never replaces the working one');
    writeFileSync(join(dir, 'release-notes', '.claude-plugin', 'plugin.json'), '{ broken json');
    const [failed] = await cog.experimental_plugins.reload('release-notes@inline');
    console.log(
      `  ok: ${failed?.ok}, code: ${failed?.code}, generation still serving: ${failed?.generation}`
    );
    claudeCodePlugin(join(dir, 'release-notes'));
    const [fixed] = await cog.experimental_plugins.reload('release-notes@inline');
    console.log(`  ok: ${fixed?.ok}, generation now: ${fixed?.generation}`);

    section('5. Unload in reverse order');
  } finally {
    await cog.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
