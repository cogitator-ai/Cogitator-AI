import { code } from '../code.js';
import { runScript } from '../package-manager.js';
import { hasFeature } from '../spec.js';
import { cogitatorVersion } from '../versions.js';
import type { FeatureModule } from './types.js';

const NOTES_SERVER_TS = code`
  import { mkdir, readFile, writeFile } from 'node:fs/promises';
  import { dirname } from 'node:path';
  import { tool } from '@cogitator-ai/core';
  import { serveMCPTools } from '@cogitator-ai/mcp';
  import { z } from 'zod';

  /**
   * A small MCP server: notes in a JSON file, served over stdio. The assistant
   * connects to it in src/mcp/client.ts, and any MCP client (Claude Desktop,
   * Cursor) can use it the same way.
   */
  const NOTES_PATH = process.env.NOTES_PATH ?? 'data/notes.json';

  interface Note {
    id: number;
    text: string;
    createdAt: string;
  }

  async function readNotes(): Promise<Note[]> {
    try {
      return JSON.parse(await readFile(NOTES_PATH, 'utf8')) as Note[];
    } catch {
      return [];
    }
  }

  async function writeNotes(notes: Note[]): Promise<void> {
    await mkdir(dirname(NOTES_PATH), { recursive: true });
    await writeFile(NOTES_PATH, JSON.stringify(notes, null, 2));
  }

  const addNote = tool({
    name: 'add_note',
    description: 'Save a short note for later.',
    parameters: z.object({ text: z.string().min(1).max(2_000).describe('The note') }),
    execute: async ({ text }) => {
      const notes = await readNotes();
      const note = { id: (notes.at(-1)?.id ?? 0) + 1, text, createdAt: new Date().toISOString() };
      await writeNotes([...notes, note]);
      return note;
    },
  });

  const searchNotes = tool({
    name: 'search_notes',
    description: 'Find saved notes that contain all the given words. Without words, list every note.',
    parameters: z.object({ query: z.string().default('').describe('Words to look for') }),
    execute: async ({ query }) => {
      const words = query.toLowerCase().split(/\\s+/).filter(Boolean);
      const notes = await readNotes();
      return notes.filter((note) => words.every((word) => note.text.toLowerCase().includes(word)));
    },
  });

  await serveMCPTools([addNote, searchNotes], { name: 'notes', version: '1.0.0', transport: 'stdio' });
`;

const MCP_CLIENT_TS = code`
  import { fileURLToPath } from 'node:url';
  import type { Tool } from '@cogitator-ai/core';
  import { connectMCPServer } from '@cogitator-ai/mcp';

  /**
   * The command that starts src/mcp/notes-server with the runtime of this
   * process: Bun runs the sources as they are, Node needs tsx for them and
   * runs dist/ after a build.
   */
  function notesServerCommand(): { command: string; args: string[] } {
    const fromSources = import.meta.url.endsWith('.ts');
    const server = fileURLToPath(new URL(\`./notes-server.\${fromSources ? 'ts' : 'js'}\`, import.meta.url));
    const loader = fromSources && !process.versions.bun ? ['--import', 'tsx'] : [];
    return { command: process.execPath, args: [...loader, server] };
  }

  /**
   * Starts the notes MCP server and returns its tools as Cogitator tools. Add
   * more servers the same way, for example the official filesystem server:
   * \`connectMCPServer({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] })\`.
   */
  export async function loadNotesTools(env: Record<string, string> = {}): Promise<{ tools: Tool[]; close: () => Promise<void> }> {
    const { tools, cleanup } = await connectMCPServer({ transport: 'stdio', ...notesServerCommand(), env, timeout: 30_000 });
    return { tools, close: cleanup };
  }

  /**
   * The MCP tools the assistant gets. A server that does not start leaves the
   * assistant without its tools instead of stopping the project.
   */
  async function connect(): Promise<Tool[]> {
    try {
      return (await loadNotesTools()).tools;
    } catch (error) {
      console.warn(\`The notes MCP server did not start, continuing without it: \${error instanceof Error ? error.message : error}\`);
      return [];
    }
  }

  export const mcpTools = await connect();
`;

const MCP_SERVE_TS = code`
  import { serveAgents } from '@cogitator-ai/mcp';
  import { agents, cogitator } from '../cogitator.js';

  /**
   * Serves every agent of the project as an MCP tool over stdio, so Claude
   * Desktop, Cursor or Claude Code can hand them tasks.
   */
  await serveAgents(cogitator, Object.values(agents));
`;

const MCP_TEST_TS = code`
  import { mkdtempSync, rmSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import type { Tool } from '@cogitator-ai/core';
  import { loadNotesTools } from '../src/mcp/client.js';

  const context = { agentId: 'test', runId: 'test', signal: new AbortController().signal };
  let dir: string;
  let notes: { tools: Tool[]; close: () => Promise<void> };

  function named(name: string): Tool {
    const found = notes.tools.find((tool) => tool.name === name);
    if (!found) throw new Error(\`The notes server has no \${name} tool\`);
    return found;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-'));
    notes = await loadNotesTools({ NOTES_PATH: join(dir, 'notes.json') });
  });

  afterAll(async () => {
    await notes.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('notes MCP server', () => {
    it('offers its tools to Cogitator', () => {
      expect(notes.tools.map((tool) => tool.name).sort()).toEqual(['add_note', 'search_notes']);
    });

    it('saves notes and finds them again', async () => {
      await named('add_note').execute({ text: 'Buy oat milk' }, context);
      await named('add_note').execute({ text: 'Call the dentist' }, context);

      const found = await named('search_notes').execute({ query: 'milk' }, context);
      expect(found).toEqual([expect.objectContaining({ id: 1, text: 'Buy oat milk' })]);
    });
  });
`;

/** Tools from MCP servers for the assistant, and the project's agents served over MCP. */
export const mcpFeature: FeatureModule = {
  id: 'feature:mcp',
  applies: (spec) => hasFeature(spec, 'mcp'),
  apply(project) {
    project
      .dependency('@cogitator-ai/mcp', cogitatorVersion('@cogitator-ai/mcp'))
      .file('src/mcp/notes-server.ts', NOTES_SERVER_TS)
      .file('src/mcp/client.ts', MCP_CLIENT_TS)
      .file('src/mcp/serve.ts', MCP_SERVE_TS)
      .file('tests/mcp.test.ts', MCP_TEST_TS)
      .toolSet('mcpTools', '../mcp/client.js')
      .script('mcp:serve', 'tsx --env-file-if-exists=.env src/mcp/serve.ts')
      .ignore('data/')
      .instruct('Keep notes for the user with add_note and find them with search_notes.');
  },
  finalize(project) {
    const pm = project.spec.packageManager;
    project.section(
      'MCP',
      code`
        - \`src/mcp/notes-server.ts\` is an MCP server of its own (\`serveMCPTools\`): notes in \`data/notes.json\` over stdio.
        - \`src/mcp/client.ts\` starts it and hands its tools to the assistant (\`connectMCPServer\`). Add other servers there; a server that fails to start is skipped with a warning.
        - \`src/mcp/serve.ts\` serves every agent of the registry as an MCP tool (\`serveAgents\`): \`${runScript(pm, 'mcp:serve')}\`. Point Claude Desktop, Cursor or Claude Code at that command to hand your agents tasks.
      `
    );
    project.readmeSection(
      'MCP',
      code`
        The assistant uses the tools of the notes MCP server in \`src/mcp/notes-server.ts\`. To use your agents from Claude Desktop, Cursor or Claude Code, add this server to their MCP settings:

        \`\`\`json
        {
          "mcpServers": {
            "${project.spec.name}": {
              "command": "${pm === 'npm' ? 'npm' : pm}",
              "args": [${pm === 'npm' ? '"run", "--silent", "mcp:serve"' : '"--silent", "mcp:serve"'}],
              "cwd": "/absolute/path/to/${project.spec.name}"
            }
          }
        }
        \`\`\`
      `
    );
  },
};
