import { MCPServer } from '@cogitator-ai/mcp/server';
import { bridgePaths } from '../../paths';
import { BRIDGE_INSTRUCTIONS, bridgeTools } from '../../tools';

/**
 * What `cogitator bridge mcp` does, for the tests of this package, which have no command line:
 * serves the bridge's tools over stdio, for the dispatcher in the folder `--home` names.
 */
const args = process.argv.slice(2);
const at = args.indexOf('--home');
const home = at === -1 ? undefined : args[at + 1];

const server = new MCPServer({
  name: 'cogitator-bridge',
  version: '0.0.0',
  transport: 'stdio',
  logging: false,
  instructions: BRIDGE_INSTRUCTIONS,
});
server.registerTools(
  bridgeTools({ socketPath: bridgePaths({ ...(home && { home }), env: process.env }).socket })
);
await server.start();
process.stdin.once('end', () => {
  void server.stop().finally(() => process.exit(0));
});
