import { header, section } from '../_shared/setup.js';
import { tool } from '@cogitator-ai/core';
import { MCPClient, MCPServer, type MCPToolContext } from '@cogitator-ai/mcp';
import { z } from 'zod';

const archive = tool({
  name: 'archive_project',
  description: 'Archive a project. Asks the user first.',
  parameters: z.object({ project: z.string() }),
  requiresApproval: true,
  execute: async ({ project }) => `archived ${project}`,
});

const migrate = tool({
  name: 'migrate_database',
  description: 'Migrate the database, asking which backup to keep halfway.',
  parameters: z.object({ database: z.string() }),
  execute: async ({ database }, context: MCPToolContext) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const reply = await context.elicit?.({
      message: `Migrated ${database} to the new schema. Keep which backup?`,
      schema: {
        type: 'object',
        properties: { keep: { type: 'string', enum: ['daily', 'weekly'] } },
        required: ['keep'],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const keep = reply?.action === 'accept' ? String(reply.content.keep) : 'none';
    return { database, migrated: true, backupKept: keep };
  },
});

const latency = tool({
  name: 'latency_samples',
  description: 'Recent request latencies in ms.',
  parameters: z.object({}),
  outputSchema: z.array(z.number()),
  execute: async () => [41, 38, 77, 40],
});

async function main() {
  header('05 - MCP 2026-07-28: Rounds, Tasks and Structured Results');

  const server = new MCPServer({
    name: 'ops',
    version: '1.0.0',
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
    tasks: { promoteAfterMs: 500, pollIntervalMs: 250 },
  });
  server.registerTools([archive, migrate, latency]);
  await server.start();
  const url = `http://127.0.0.1:${server.getPort()}/mcp`;

  const client = await MCPClient.connect({
    transport: 'http',
    url,
    elicitation: async (request) => {
      console.log(`  ? ${request.message}`);
      return request.message.includes('Approve')
        ? { action: 'accept', content: { approve: true } }
        : { action: 'accept', content: { keep: 'weekly' } };
    },
  });

  try {
    section('1. The client asks server/discover and speaks the new revision');
    const discovery = client.discover();
    console.log(
      `  ${discovery.serverInfo?.name} speaks ${discovery.protocolVersion} (${client.era})`
    );

    section('2. An approval is a round of the call');
    console.log(`  ${String(await client.callTool('archive_project', { project: 'atlas' }))}`);

    section('3. A long call becomes a task, its question asked in the task');
    const result = await client.callTool(
      'migrate_database',
      { database: 'orders' },
      { update: (progress) => console.log(`  ... ${JSON.stringify(progress.details)}`) }
    );
    console.log(`  ${JSON.stringify(result)}`);

    section('4. Structured results of any shape');
    console.log(`  ${JSON.stringify(await client.callTool('latency_samples', {}))}`);
  } finally {
    await client.close();
    await server.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
