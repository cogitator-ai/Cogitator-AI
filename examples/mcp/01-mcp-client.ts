import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { MCPClient } from '@cogitator-ai/mcp';
import { Agent } from '@cogitator-ai/core';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED_DIR = join(import.meta.dirname, '.tmp-mcp');

function setupTestFiles() {
  mkdirSync(ALLOWED_DIR, { recursive: true });

  writeFileSync(
    join(ALLOWED_DIR, 'hello.txt'),
    'Hello from Cogitator! This file was created for the MCP example.'
  );

  writeFileSync(
    join(ALLOWED_DIR, 'inventory.json'),
    JSON.stringify(
      {
        items: [
          { name: 'Flux Capacitor', qty: 3, price: 1955 },
          { name: 'Hoverboard', qty: 12, price: 499.99 },
          { name: 'Self-lacing Shoes', qty: 7, price: 350 },
        ],
      },
      null,
      2
    )
  );
}

function cleanup() {
  rmSync(ALLOWED_DIR, { recursive: true, force: true });
}

async function main() {
  header('01 — MCP Client: Filesystem Server');
  setupTestFiles();

  let client: MCPClient | undefined;

  try {
    section('1. Connect to MCP server via stdio');

    client = await MCPClient.connect({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', ALLOWED_DIR],
      timeout: 30_000,
    });

    console.log('Connected:', client.isConnected());
    console.log('Capabilities:', client.getCapabilities());

    section('2. Discover available tools');

    const toolDefs = await client.listToolDefinitions();
    console.log(`Found ${toolDefs.length} tools:\n`);
    for (const def of toolDefs) {
      const params = Object.keys(def.inputSchema.properties ?? {}).join(', ');
      console.log(`  ${def.name}(${params})`);
      console.log(`    ${def.description}\n`);
    }

    section('3. Call a tool directly');

    const files = await client.callTool('list_directory', { path: ALLOWED_DIR });
    console.log('Directory listing:', files);

    const content = await client.callTool('read_file', {
      path: join(ALLOWED_DIR, 'hello.txt'),
    });
    console.log('File content:', content);

    section('4. Get tools as Cogitator Tool instances');

    const tools = await client.getTools();
    console.log(`Converted ${tools.length} MCP tools to Cogitator format:`);
    for (const t of tools) {
      console.log(`  - ${t.name}: ${t.description}`);
    }

    section('5. Use MCP tools with a Cogitator agent');

    const readFile = tools.find((t) => t.name === 'read_file' || t.name === 'read_text_file');
    const listDir = tools.find((t) => t.name === 'list_directory');
    const agentTools = [readFile, listDir].filter(Boolean) as typeof tools;

    const cog = createCogitator();
    const agent = new Agent({
      name: 'fs-assistant',
      model: DEFAULT_MODEL,
      instructions: `You are a filesystem assistant. You have access to tools that can read and list files.
The allowed directory is: ${ALLOWED_DIR}
Be concise in your responses.`,
      tools: agentTools,
      temperature: 0.2,
      maxIterations: 10,
    });

    const result = await cog.run(agent, {
      input: `Read the inventory.json file from ${ALLOWED_DIR} and tell me the total value of all items in stock (qty * price for each, then sum).`,
    });

    console.log('Agent output:', result.output);
    console.log('Tool calls:', result.toolCalls.map((tc) => tc.name).join(', '));

    await cog.close();
  } catch (error) {
    if (error instanceof Error) {
      console.error('Error:', error.message);
    } else {
      console.error('Error:', error);
    }
    process.exitCode = 1;
  } finally {
    if (client) {
      await client.close();
      console.log('\nMCP connection closed.');
    }
    cleanup();
  }
}

main();
