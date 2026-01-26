/**
 * MCP Integration Example
 *
 * Demonstrates connecting to MCP servers and using their tools with Cogitator agents.
 * MCP (Model Context Protocol) allows agents to use external tools and resources.
 */

import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { MCPClient, MCPServer, connectMCPServer } from '@cogitator-ai/mcp';
import { z } from 'zod';

async function useFilesystemMCP() {
  console.log('=== Filesystem MCP Server ===\n');

  const { tools, cleanup } = await connectMCPServer({
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    timeout: 30000,
  });

  console.log(
    'Available tools:',
    tools.map((t) => t.name)
  );

  const cog = new Cogitator({
    llm: {
      defaultProvider: 'ollama',
      providers: { ollama: { baseUrl: 'http://localhost:11434' } },
    },
  });

  const fileAgent = new Agent({
    name: 'file-manager',
    model: 'qwen2.5:7b',
    instructions: `You can read and write files in /tmp directory.
      Use the available filesystem tools to help the user.`,
    tools,
  });

  const result = await cog.run(fileAgent, {
    input: 'Create a file called hello.txt with "Hello from MCP!" inside it.',
    onToolCall: (call) => console.log(`Tool: ${call.name}`, call.arguments),
  });

  console.log('\nResponse:', result.output);

  await cleanup();
  await cog.close();
}

async function useMultipleMCPServers() {
  console.log('\n=== Multiple MCP Servers ===\n');

  const fsClient = await MCPClient.connect({
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    clientName: 'cogitator-fs',
    retry: { maxRetries: 3, initialDelay: 1000 },
    onReconnecting: (attempt) => console.log(`FS reconnecting: attempt ${attempt}`),
    onReconnected: () => console.log('FS reconnected'),
  });

  const memoryClient = await MCPClient.connect({
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    clientName: 'cogitator-memory',
  });

  console.log('FS capabilities:', fsClient.getCapabilities());
  console.log('Memory capabilities:', memoryClient.getCapabilities());

  const fsTools = await fsClient.getTools();
  const memoryTools = await memoryClient.getTools();

  console.log(`Loaded ${fsTools.length} fs tools, ${memoryTools.length} memory tools`);

  const cog = new Cogitator({
    llm: {
      defaultProvider: 'ollama',
      providers: { ollama: { baseUrl: 'http://localhost:11434' } },
    },
  });

  const multiAgent = new Agent({
    name: 'multi-tool-agent',
    model: 'qwen2.5:7b',
    instructions: 'You have access to filesystem and knowledge graph tools.',
    tools: [...fsTools, ...memoryTools],
  });

  const result = await cog.run(multiAgent, {
    input: 'Store a fact: TypeScript was created by Microsoft. Then list files in /tmp.',
  });

  console.log('\nResponse:', result.output);

  await fsClient.close();
  await memoryClient.close();
  await cog.close();
}

async function exposeCogitatorAsMCP() {
  console.log('\n=== Expose Cogitator Tools as MCP ===\n');

  const calculator = tool({
    name: 'calculator',
    description: 'Perform mathematical calculations',
    parameters: z.object({
      expression: z.string().describe('Math expression to evaluate'),
    }),
    execute: async ({ expression }) => {
      const result = Function(`'use strict'; return (${expression})`)();
      return { expression, result };
    },
  });

  const randomNumber = tool({
    name: 'random_number',
    description: 'Generate a random number',
    parameters: z.object({
      min: z.number().default(0).describe('Minimum value'),
      max: z.number().default(100).describe('Maximum value'),
    }),
    execute: async ({ min, max }) => {
      return { value: Math.floor(Math.random() * (max - min + 1)) + min };
    },
  });

  const server = new MCPServer({
    name: 'cogitator-tools',
    version: '1.0.0',
    transport: 'stdio',
    logging: true,
  });

  server.registerTool(calculator);
  server.registerTool(randomNumber);

  console.log(
    'Registered tools:',
    server.getRegisteredTools().map((t) => t.name)
  );

  console.log('\nTo use with Claude Desktop, add to config:');
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          cogitator: {
            command: 'npx',
            args: ['tsx', 'examples/mcp-integration.ts', '--serve'],
          },
        },
      },
      null,
      2
    )
  );

  if (process.argv.includes('--serve')) {
    console.log('\nStarting MCP server...');
    await server.start();
  }
}

async function handleMCPResources() {
  console.log('\n=== MCP Resources ===\n');

  const client = await MCPClient.connect({
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  });

  const capabilities = client.getCapabilities();

  if (capabilities.resources) {
    const resources = await client.listResources();
    console.log('Available resources:', resources.length);

    for (const resource of resources.slice(0, 3)) {
      console.log(`  - ${resource.name}: ${resource.uri}`);
      if (resource.mimeType) {
        console.log(`    Type: ${resource.mimeType}`);
      }
    }

    if (resources.length > 0) {
      const content = await client.readResource(resources[0].uri);
      console.log(`\nFirst resource content (${resources[0].name}):`);
      console.log(content.text?.slice(0, 200) ?? '(binary data)');
    }
  } else {
    console.log('Server does not support resources');
  }

  await client.close();
}

async function handleMCPPrompts() {
  console.log('\n=== MCP Prompts ===\n');

  const client = await MCPClient.connect({
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  });

  const capabilities = client.getCapabilities();

  if (capabilities.prompts) {
    const prompts = await client.listPrompts();
    console.log('Available prompts:', prompts.length);

    for (const prompt of prompts) {
      console.log(`  - ${prompt.name}: ${prompt.description ?? '(no description)'}`);
      if (prompt.arguments) {
        console.log(`    Args: ${prompt.arguments.map((a) => a.name).join(', ')}`);
      }
    }

    if (prompts.length > 0) {
      const messages = await client.getPrompt(prompts[0].name);
      console.log(`\nPrompt "${prompts[0].name}" messages:`, messages.length);
    }
  } else {
    console.log('Server does not support prompts');
  }

  await client.close();
}

async function withRetryAndReconnection() {
  console.log('\n=== Retry and Reconnection ===\n');

  const client = await MCPClient.connect({
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    retry: {
      maxRetries: 5,
      initialDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 2,
      retryOnConnectionLoss: true,
    },
    autoReconnect: true,
    onReconnecting: (attempt) => {
      console.log(`Reconnection attempt ${attempt}...`);
    },
    onReconnected: () => {
      console.log('Successfully reconnected!');
    },
    onReconnectFailed: (error) => {
      console.error('Reconnection failed:', error.message);
    },
  });

  console.log('Connected:', client.isConnected());

  const tools = await client.listToolDefinitions();
  console.log('Tools:', tools.length);

  if (!client.isConnected()) {
    console.log('Connection lost, attempting manual reconnect...');
    await client.reconnect();
  }

  await client.close();
}

async function main() {
  console.log('MCP Integration Examples\n');

  const mode = process.argv[2];

  switch (mode) {
    case '--serve':
      await exposeCogitatorAsMCP();
      break;
    case '--fs':
      await useFilesystemMCP();
      break;
    case '--multi':
      await useMultipleMCPServers();
      break;
    case '--resources':
      await handleMCPResources();
      break;
    case '--prompts':
      await handleMCPPrompts();
      break;
    case '--retry':
      await withRetryAndReconnection();
      break;
    default:
      console.log('Usage:');
      console.log('  npx tsx examples/mcp-integration.ts --fs        # Filesystem MCP');
      console.log('  npx tsx examples/mcp-integration.ts --multi     # Multiple servers');
      console.log('  npx tsx examples/mcp-integration.ts --serve     # Expose as MCP server');
      console.log('  npx tsx examples/mcp-integration.ts --resources # List MCP resources');
      console.log('  npx tsx examples/mcp-integration.ts --prompts   # List MCP prompts');
      console.log('  npx tsx examples/mcp-integration.ts --retry     # Retry/reconnection');
      console.log('\nNote: Requires MCP servers installed. Run with npx or install globally.');
  }
}

main().catch(console.error);
