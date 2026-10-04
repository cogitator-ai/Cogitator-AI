import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Agent, tool } from '@cogitator-ai/core';
import {
  MCPClient,
  MCPServer,
  MCPToolError,
  connectMCPServer,
  serveAgents,
  type AgentToolAnswer,
} from '@cogitator-ai/mcp';
import { z } from 'zod';
import { PACKAGE_DIR } from '../../packages.js';
import type { StageDefinition } from '../../runner/types.js';
import { CORE, MCP, TYPES, assertCalled, calledTools, excerpt } from './shared.js';

/** Access codes the model cannot guess, so a correct answer proves the MCP tool ran. */
const VAULT: Record<string, string> = {
  aurora: 'AUR-7741-QX',
  borealis: 'BOR-1208-LM',
};

const STDIO_SERVER = join(PACKAGE_DIR, 'fixtures', 'protocols', 'mcp-stdio-server.mjs');

/**
 * Cogitator tools, resources and prompts served over Streamable HTTP with auth, consumed by
 * `MCPClient`, handed to an agent as ordinary tools, plus the stdio direction with built-ins.
 */
export const mcpToolsStage: StageDefinition = {
  id: 'mcp-tools',
  title: 'MCP tools, resources and prompts',
  description:
    'An authenticated MCP server exposes a Cogitator tool, resources and a prompt, and an agent answers through the MCP tool.',
  packages: [MCP, CORE, TYPES],
  needs: ['handshake'],
  timeoutMs: 150_000,
  async run(ctx) {
    const token = randomUUID();
    const userId = 'gauntlet-operator';
    let vaultCalls = 0;

    const vaultLookup = tool({
      name: 'vault_lookup',
      description: 'Look up the access code stored in the vault for a project codename.',
      parameters: z.object({ codename: z.string().describe('Project codename, lowercase') }),
      execute: async ({ codename }, context) => {
        vaultCalls++;
        const code = VAULT[codename.trim().toLowerCase()];
        if (!code) throw new Error(`No vault entry for ${codename}`);
        return { codename, code, caller: context.userId ?? null };
      },
    });

    const server = await ctx.check('HTTP server starts with auth', async (evidence) => {
      const server = new MCPServer({
        name: 'gauntlet-vault',
        version: '1.0.0',
        transport: 'http',
        port: 0,
        host: '127.0.0.1',
        auth: (request) =>
          request.headers.authorization === `Bearer ${token}` ? { userId } : undefined,
      });
      server.registerTool(vaultLookup);
      server.registerResource({
        uri: 'vault://manifest',
        name: 'Vault manifest',
        description: 'Codenames stored in the vault',
        mimeType: 'application/json',
        read: async (_params, caller) => ({
          text: JSON.stringify({ codenames: Object.keys(VAULT), reader: caller?.userId ?? null }),
        }),
      });
      server.registerResource({
        uri: 'vault://project/{codename}',
        name: 'Project card',
        description: 'Public card of a project',
        mimeType: 'text/plain',
        read: async ({ codename }) => ({ text: `Project ${codename} is sealed in the vault.` }),
      });
      server.registerPrompt({
        name: 'audit',
        description: 'Ask for an access audit of a project',
        arguments: [{ name: 'codename', required: true }],
        get: ({ codename }) => ({
          messages: [{ role: 'user', content: `Audit every vault access to ${codename}.` }],
        }),
      });
      await server.start();
      ctx.onCleanup(() => server.stop());
      evidence('port', server.getPort());
      evidence('running', server.isRunning());
      if (!server.isRunning() || !server.getPort()) throw new Error('Server did not bind a port');
      return server;
    });
    const url = `http://127.0.0.1:${server.getPort()}/mcp`;

    await ctx.check('request without a token is answered 401', async (evidence) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        signal: ctx.signal,
      });
      await response.body?.cancel();
      evidence('status', response.status);
      if (response.status !== 401) throw new Error(`Expected 401, got ${response.status}`);
    });

    const client = await ctx.check('client connects over Streamable HTTP', async (evidence) => {
      const client = await MCPClient.connect({
        transport: 'http',
        url,
        headers: { Authorization: `Bearer ${token}` },
        clientName: 'gauntlet',
        timeout: 10_000,
      });
      ctx.onCleanup(() => client.close());
      const capabilities = client.getCapabilities();
      evidence('connected', client.isConnected());
      evidence('capabilities', capabilities);
      if (!capabilities.tools || !capabilities.resources || !capabilities.prompts) {
        throw new Error('Server did not advertise tools, resources and prompts');
      }
      return client;
    });

    await ctx.check('tool definition carries the Zod schema', async (evidence) => {
      const definitions = await client.listToolDefinitions();
      const vault = definitions.find((definition) => definition.name === 'vault_lookup');
      evidence(
        'tools',
        definitions.map((definition) => definition.name)
      );
      evidence('inputSchema', vault?.inputSchema);
      if (!vault) throw new Error('vault_lookup is not listed');
      if (!('codename' in vault.inputSchema.properties)) {
        throw new Error('inputSchema lost the codename property');
      }
    });

    await ctx.check('direct call reaches the tool with the caller', async (evidence) => {
      const result = (await client.callTool('vault_lookup', { codename: 'aurora' })) as {
        code?: string;
        caller?: string;
      };
      evidence('result', result);
      if (result.code !== VAULT.aurora) throw new Error(`Wrong code: ${JSON.stringify(result)}`);
      if (result.caller !== userId) {
        throw new Error(
          `The auth userId did not reach the tool context (caller: ${String(result.caller)})`
        );
      }
    });

    await ctx.check('tool failure surfaces as MCPToolError', async (evidence) => {
      try {
        await client.callTool('vault_lookup', { codename: 'nebula' });
      } catch (error) {
        evidence('errorType', error instanceof Error ? error.constructor.name : typeof error);
        evidence('message', error instanceof Error ? error.message : String(error));
        if (!(error instanceof MCPToolError)) {
          throw new Error('Expected an MCPToolError', { cause: error });
        }
        if (error.toolName !== 'vault_lookup') {
          throw new Error(`Wrong toolName: ${error.toolName}`, { cause: error });
        }
        return;
      }
      throw new Error('A failing tool call resolved instead of throwing');
    });

    await ctx.check('static and templated resources read back', async (evidence) => {
      const resources = await client.listResources();
      evidence(
        'resources',
        resources.map((resource) => resource.uri)
      );
      const manifest = await client.readResource('vault://manifest');
      const parsed = JSON.parse(manifest.text ?? '{}') as { codenames?: string[]; reader?: string };
      evidence('manifest', parsed);
      if (!parsed.codenames?.includes('borealis')) throw new Error('Manifest is missing codenames');
      if (parsed.reader !== userId) throw new Error('Resource read did not receive the caller');
      const card = await client.readResource('vault://project/aurora');
      evidence('template', card.text);
      if (!card.text?.includes('aurora'))
        throw new Error('Template parameter did not reach read()');
      if (card.mimeType !== 'text/plain')
        throw new Error(`Wrong mimeType: ${String(card.mimeType)}`);
    });

    await ctx.check('prompt renders with its argument', async (evidence) => {
      const prompts = await client.listPrompts();
      evidence(
        'prompts',
        prompts.map((prompt) => prompt.name)
      );
      const messages = await client.getPrompt('audit', { codename: 'borealis' });
      evidence('messages', messages);
      const text = messages[0]?.content.text ?? '';
      if (messages[0]?.role !== 'user' || !text.includes('borealis')) {
        throw new Error('Prompt did not render the argument into a user message');
      }
    });

    await ctx.check('agent answers through the MCP tool', async (evidence) => {
      const tools = await client.getTools();
      const before = vaultCalls;
      const agent = new Agent({
        name: 'mcp-operator',
        model: ctx.model,
        instructions:
          'You answer questions about vault access codes. Always look codes up with the vault_lookup tool, never guess. Reply with the code only.',
        tools,
        maxIterations: 4,
      });
      const run = await ctx.cogitator.run(agent, {
        input: 'What is the access code for project "borealis"?',
        signal: ctx.signal,
      });
      evidence('toolCalls', calledTools(run));
      evidence('serverCalls', vaultCalls - before);
      evidence('output', excerpt(run.output));
      assertCalled(run, 'vault_lookup');
      if (vaultCalls === before) throw new Error('The MCP server never received the call');
      if (!run.output.includes(VAULT.borealis!))
        throw new Error('The answer lacks the code the tool returned');
    });

    await ctx.check('built-in tools served over stdio', async (evidence) => {
      const {
        client: stdio,
        tools,
        cleanup,
      } = await connectMCPServer({
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_SERVER],
        cwd: PACKAGE_DIR,
        timeout: 20_000,
        autoReconnect: false,
      });
      ctx.onCleanup(cleanup);
      evidence(
        'tools',
        tools.map((t) => t.name)
      );
      if (!['calculator', 'hash', 'uuid'].every((name) => tools.some((t) => t.name === name))) {
        throw new Error('The stdio server did not list the served built-ins');
      }
      const hashed = (await stdio.callTool('hash', { data: 'gauntlet', algorithm: 'sha256' })) as {
        hash?: string;
      };
      const expected = createHash('sha256').update('gauntlet').digest('hex');
      evidence('hash', hashed.hash);
      if (hashed.hash !== expected) throw new Error('The stdio hash differs from node:crypto');
      const calculated = (await stdio.callTool('calculator', { expression: '(17 + 25) * 3' })) as {
        result?: number;
      };
      evidence('calculator', calculated);
      if (calculated.result !== 126)
        throw new Error(`Calculator answered ${JSON.stringify(calculated)}`);
      await cleanup();
    });
  },
};

/** Cogitator agents served as MCP tools, including a paused approval resumed through MCP. */
export const mcpAgentsStage: StageDefinition = {
  id: 'mcp-agents',
  title: 'Agents served over MCP',
  description:
    'serveAgents turns agents into MCP tools: one answers a task, another pauses on a tool approval and resumes once approved.',
  packages: [MCP, CORE, TYPES],
  needs: ['handshake'],
  timeoutMs: 180_000,
  async run(ctx) {
    let shredded: string[] = [];

    const catalogue = tool({
      name: 'catalogue_lookup',
      description: 'Find the shelf mark of a book in the library catalogue.',
      parameters: z.object({ title: z.string() }),
      execute: async ({ title }) =>
        /cartographer/i.test(title)
          ? { title: 'The Last Cartographer', shelf: 'QX-88-B', copies: 2 }
          : { title, shelf: null, copies: 0 },
    });

    const shred = tool({
      name: 'shred_document',
      description: 'Permanently shred an archived document by its id.',
      parameters: z.object({ documentId: z.string() }),
      requiresApproval: true,
      execute: async ({ documentId }) => {
        shredded = [...shredded, documentId];
        return { documentId, shredded: true };
      },
    });

    const librarian = new Agent({
      name: 'librarian',
      description: 'Finds where books are shelved in the library.',
      model: ctx.model,
      instructions:
        'You locate books. Always use catalogue_lookup and answer with the shelf mark it returns.',
      tools: [catalogue],
      maxIterations: 4,
    });
    const archivist = new Agent({
      name: 'archivist',
      description: 'Manages the document archive.',
      model: ctx.model,
      instructions:
        'You manage the archive. When asked to shred a document, call shred_document with its id, then confirm in one sentence.',
      tools: [shred],
      maxIterations: 4,
    });

    const server = await ctx.check('serveAgents starts an HTTP server', async (evidence) => {
      const server = await serveAgents(ctx.cogitator, [librarian, archivist], {
        transport: 'http',
        port: 0,
        host: '127.0.0.1',
      });
      ctx.onCleanup(() => server.stop());
      evidence('port', server.getPort());
      evidence('tools', server.getRegisteredTools());
      return server;
    });

    const client = await ctx.check('agent tools are listed', async (evidence) => {
      const client = await MCPClient.connect({
        transport: 'http',
        url: `http://127.0.0.1:${server.getPort()}/mcp`,
        timeout: 10_000,
      });
      ctx.onCleanup(() => client.close());
      const names = (await client.listToolDefinitions()).map((definition) => definition.name);
      evidence('tools', names);
      for (const name of ['librarian', 'archivist', 'archivist_resume']) {
        if (!names.includes(name)) throw new Error(`${name} is not listed`);
      }
      if (names.includes('librarian_resume')) {
        throw new Error('librarian has no approval tools but got a resume tool');
      }
      return client;
    });

    await ctx.check('agent tool answers a task', async (evidence) => {
      const answer = (await client.callTool(
        'librarian',
        { task: 'Where is "The Last Cartographer" shelved?' },
        { timeout: 90_000 }
      )) as AgentToolAnswer;
      evidence('status', answer.status);
      evidence('threadId', answer.threadId);
      if (answer.status !== 'completed')
        throw new Error(`Expected completed, got ${answer.status}`);
      evidence('output', excerpt(answer.output));
      if (!answer.output.includes('QX-88-B')) throw new Error('The answer lacks the shelf mark');
    });

    const paused = await ctx.check('approval pauses the run over MCP', async (evidence) => {
      const answer = (await client.callTool(
        'archivist',
        { task: 'Shred document DOC-4471.' },
        { timeout: 90_000 }
      )) as AgentToolAnswer;
      evidence('status', answer.status);
      evidence('shredded', shredded);
      if (answer.status !== 'paused') {
        throw new Error(`Expected a paused answer, got ${answer.status}`);
      }
      evidence(
        'pending',
        answer.pendingApprovals.map((request) => request.toolName)
      );
      if (!answer.pendingApprovals.some((request) => request.toolName === 'shred_document')) {
        throw new Error('shred_document is not among the pending approvals');
      }
      if (shredded.length > 0) throw new Error('The tool ran before it was approved');
      return answer;
    });

    await ctx.check('resume tool runs the approved call', async (evidence) => {
      const answer = (await client.callTool(
        'archivist_resume',
        { threadId: paused.threadId, approved: true },
        { timeout: 90_000 }
      )) as AgentToolAnswer;
      evidence('status', answer.status);
      evidence('shredded', shredded);
      if (answer.status !== 'completed')
        throw new Error(`Expected completed, got ${answer.status}`);
      evidence('output', excerpt(answer.output));
      if (!shredded.some((id) => id.includes('4471'))) {
        throw new Error('The approved call never reached shred_document');
      }
    });
  },
};
