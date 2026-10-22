import { Agent } from '@cogitator-ai/core';
import { Gateway, githubChannel } from '@cogitator-ai/channels';
import { createCogitator, DEFAULT_MODEL, requireEnv } from '../_shared/setup';

/**
 * An agent that answers on GitHub: new issues and pull requests, comments on
 * them, reviews and comments on lines of a diff, whenever they mention the
 * bot. Each issue or pull request is a conversation of its own, and so is
 * every review thread, answered in place.
 *
 * Set up a webhook on a repository (Settings, Webhooks): payload URL
 * `https://<your host>/github/webhook` (a tunnel such as `cloudflared` or
 * `ngrok` to port 8787 works for a try), content type `application/json`,
 * the secret from GITHUB_WEBHOOK_SECRET, and the events Issues, Issue
 * comments, Pull requests, Pull request reviews and Pull request review
 * comments. GITHUB_CHANNEL_TOKEN is a token of a separate bot account that
 * may write issues and pull requests there, scoped to those repositories.
 */
requireEnv('GOOGLE_API_KEY');
const token = requireEnv('GITHUB_CHANNEL_TOKEN');
const secret = requireEnv('GITHUB_WEBHOOK_SECRET');
const port = Number(process.env.GITHUB_WEBHOOK_PORT ?? 8787);
const repositories = process.env.GITHUB_REPOSITORIES?.split(',').map((name) => name.trim());

const github = githubChannel({
  token,
  webhook: { secret, port },
  trigger: 'mention',
  ...(repositories && { repositories }),
});

const agent = new Agent({
  name: 'github-assistant',
  model: DEFAULT_MODEL,
  instructions: `You help the maintainers and contributors of a software project on GitHub.
Answer the issue, pull request or review comment you are mentioned in.
Be precise and brief, use GitHub Markdown, and say so when you are not sure.`,
});

const cogitator = createCogitator({ memory: { adapter: 'memory' } });
const memory = await cogitator.getMemory();

const gateway = new Gateway({
  agent,
  cogitator,
  channels: [github],
  ...(memory && { memory }),
  reactions: { enabled: true },
  onError: (error, msg) => console.error(`Error answering ${msg.channelId}:`, error.message),
});

await gateway.start();
console.log(
  `\n  @${github.login} answers mentions, webhook at http://localhost:${port}/github/webhook. Ctrl+C stops.\n`
);

process.on('SIGINT', async () => {
  await gateway.stop();
  await cogitator.close();
  process.exit(0);
});
