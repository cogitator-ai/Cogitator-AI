import { Agent } from '@cogitator-ai/core';
import { Gateway, teamsChannel } from '@cogitator-ai/channels';
import { createCogitator, DEFAULT_MODEL, requireEnv } from '../_shared/setup';

/**
 * An agent that answers in Microsoft Teams: personal chats, and @mentions in
 * group chats and team channels, where every channel thread is a
 * conversation of its own. Answers stream into a message it edits.
 *
 * Create a single-tenant Azure Bot in the Azure portal and add a client
 * secret to its app registration: TEAMS_APP_ID, TEAMS_APP_PASSWORD and
 * TEAMS_TENANT_ID. Set its messaging endpoint to
 * `https://<your host>/api/messages` (a tunnel such as `cloudflared` or
 * `ngrok` to port 3978 works for a try), turn on the Microsoft Teams channel,
 * and upload a Teams app whose manifest names the bot by its App ID.
 */
requireEnv('GOOGLE_API_KEY');
const appId = requireEnv('TEAMS_APP_ID');
const appPassword = requireEnv('TEAMS_APP_PASSWORD');
const tenantId = requireEnv('TEAMS_TENANT_ID');
const port = Number(process.env.TEAMS_PORT ?? 3978);

const teams = teamsChannel({ appId, appPassword, tenantId, webhook: { port } });

const agent = new Agent({
  name: 'teams-assistant',
  model: DEFAULT_MODEL,
  instructions: `You help a team in Microsoft Teams.
Answer the message you are mentioned in, in one or two short paragraphs.
Use Markdown: lists, code blocks and tables render in Teams.`,
});

const cogitator = createCogitator({ memory: { adapter: 'memory' } });
const memory = await cogitator.getMemory();

const gateway = new Gateway({
  agent,
  cogitator,
  channels: [teams],
  ...(memory && { memory }),
  stream: { flushInterval: 600, minChunkSize: 40 },
  onError: (error, msg) => console.error(`Error answering ${msg.channelId}:`, error.message),
});

await gateway.start();
console.log(
  `\n  Teams messaging endpoint at http://localhost:${port}/api/messages. Ctrl+C stops.\n`
);

process.on('SIGINT', async () => {
  await gateway.stop();
  await cogitator.close();
  process.exit(0);
});
