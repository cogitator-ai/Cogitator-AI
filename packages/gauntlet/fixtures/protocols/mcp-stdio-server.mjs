/**
 * The README's Claude Desktop recipe: Cogitator built-in tools served over MCP stdio.
 * The gauntlet spawns this file as a child process and talks to it with `MCPClient`.
 */
import { calculator, hash, uuid } from '@cogitator-ai/core';
import { serveMCPTools } from '@cogitator-ai/mcp';

await serveMCPTools([calculator, hash, uuid], {
  name: 'gauntlet-builtins',
  version: '1.0.0',
  transport: 'stdio',
});
