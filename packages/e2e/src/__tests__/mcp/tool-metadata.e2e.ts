import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import { Cogitator, tool } from '@cogitator-ai/core';
import { MCPClient, MCPServer } from '@cogitator-ai/mcp';
import type { Tool } from '@cogitator-ai/types';
import { createTestAgent, ollamaSkipReason } from '../../helpers/setup';

const describeE2E = describe.skipIf((await ollamaSkipReason()) !== null);
const TEST_MODEL = process.env.TEST_MODEL || 'gpt-oss:20b';

function createRepoTools() {
  const deleted: string[] = [];
  const getRepo = tool({
    name: 'get_repo',
    title: 'Repository details',
    description: 'Get the details of a repository by name.',
    parameters: z.object({ repo: z.string() }),
    outputSchema: z.object({ repo: z.string(), stars: z.number() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async ({ repo }) => ({ repo, stars: 42 }),
  });
  const deleteRepo = tool({
    name: 'delete_repo',
    title: 'Delete repository',
    description: 'Delete a repository by name. This cannot be undone.',
    parameters: z.object({ repo: z.string().describe('Repository name, e.g. "demo"') }),
    annotations: { destructiveHint: true },
    execute: async ({ repo }) => {
      deleted.push(repo);
      return { deleted: repo };
    },
  });
  return { tools: [getRepo, deleteRepo] as Tool[], deleted };
}

async function serve(tools: Tool[]): Promise<{ server: MCPServer; client: MCPClient }> {
  const server = new MCPServer({
    name: 'e2e-repos',
    version: '1.0.0',
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
  });
  server.registerTools(tools);
  await server.start();
  const client = await MCPClient.connect({
    transport: 'http',
    url: `http://127.0.0.1:${server.getPort()}/mcp`,
  });
  return { server, client };
}

describe('MCP: tool metadata and destructive tools', () => {
  let server: MCPServer;
  let client: MCPClient;
  let cogitator: Cogitator;
  const repos = createRepoTools();

  beforeAll(async () => {
    ({ server, client } = await serve(repos.tools));
    cogitator = new Cogitator();
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
    await cogitator?.close();
  });

  it('advertises titles, hints and output schemas to MCP clients', async () => {
    const definitions = new Map(
      (await client.listToolDefinitions()).map((definition) => [definition.name, definition])
    );

    expect(definitions.get('get_repo')).toMatchObject({
      title: 'Repository details',
      annotations: { readOnlyHint: true, openWorldHint: false },
      outputSchema: { type: 'object', required: ['repo', 'stars'] },
    });
    expect(definitions.get('delete_repo')).toMatchObject({
      title: 'Delete repository',
      annotations: { destructiveHint: true },
    });
    expect(definitions.get('delete_repo')?.outputSchema).toBeUndefined();
  });

  it('returns the structured result of a tool with an output schema', async () => {
    expect(await client.callTool('get_repo', { repo: 'demo' })).toEqual({
      repo: 'demo',
      stars: 42,
    });
  });

  it('imports the metadata, and the destructive tool waits for approval', async () => {
    const tools = new Map((await client.getTools()).map((t) => [t.name, t]));
    const deleteRepo = tools.get('delete_repo')!;

    expect(tools.get('get_repo')).toMatchObject({ title: 'Repository details' });
    expect(tools.get('get_repo')?.requiresApproval).toBeUndefined();
    expect(deleteRepo.requiresApproval).toBe(true);

    repos.deleted.length = 0;
    const refused = await cogitator.invokeTool(deleteRepo, { repo: 'demo' });
    expect(refused.pendingApproval?.toolName).toBe('delete_repo');
    expect(repos.deleted).toEqual([]);

    const approved = await cogitator.invokeTool(
      deleteRepo,
      { repo: 'demo' },
      { onApproval: async () => ({ approved: true }) }
    );
    expect(approved.result).toEqual({ deleted: 'demo' });
    expect(repos.deleted).toEqual(['demo']);
  });

  it('lets the requiresApproval option turn the approval off', async () => {
    const tools = await client.getTools({ requiresApproval: false });
    expect(tools.every((t) => t.requiresApproval === undefined)).toBe(true);
  });
});

describeE2E('MCP: agent run with a destructive MCP tool (Ollama)', () => {
  let server: MCPServer;
  let client: MCPClient;
  let cogitator: Cogitator;
  const repos = createRepoTools();

  beforeAll(async () => {
    ({ server, client } = await serve(repos.tools));
    cogitator = new Cogitator({
      llm: { defaultModel: `ollama/${TEST_MODEL}` },
      memory: { adapter: 'memory' },
    });
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
    await cogitator?.close();
  });

  it('pauses before the destructive tool runs, and runs it once approved', async () => {
    const tools = (await client.getTools()).filter((t) => t.name === 'delete_repo');
    const agent = createTestAgent({
      instructions: 'You manage repositories. You MUST call delete_repo when asked to delete one.',
      tools,
      maxIterations: 3,
    });
    const input = 'Delete the repository "demo". Call delete_repo with repo "demo".';

    let paused = await cogitator.run(agent, { input, threadId: 'delete-0' });
    let threadId = 'delete-0';
    for (let attempt = 1; attempt < 4 && paused.status !== 'paused'; attempt++) {
      threadId = `delete-${attempt}`;
      paused = await cogitator.run(agent, { input, threadId });
    }

    expect(paused.status).toBe('paused');
    expect(paused.pendingApprovals?.[0]?.toolName).toBe('delete_repo');
    expect(repos.deleted).toEqual([]);

    const done = await cogitator.resume(agent, threadId, {
      defaultDecision: { approved: true },
    });
    expect(done.status).not.toBe('paused');
    expect(repos.deleted.length).toBeGreaterThan(0);
  });
});
