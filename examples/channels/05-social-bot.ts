import 'dotenv/config';
import { Agent, Cogitator } from '@cogitator-ai/core';
import { Gateway, blueskyChannel, FileTokenStore, threadsChannel } from '@cogitator-ai/channels';
import type { Channel } from '@cogitator-ai/types';

/**
 * An agent that answers people on Bluesky (mentions, replies, direct
 * messages) and Threads (replies and mentions, polled here, see the docs
 * for webhooks). Answers go out finished, as threads of posts when long.
 */
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY) {
  console.error('\n  Missing GOOGLE_API_KEY.\n');
  process.exit(1);
}

const tokens = new FileTokenStore({ path: '.cogitator/tokens.json' });
const channels: Channel[] = [];

if (process.env.BLUESKY_HANDLE && process.env.BLUESKY_APP_PASSWORD) {
  channels.push(
    blueskyChannel({
      identifier: process.env.BLUESKY_HANDLE,
      appPassword: process.env.BLUESKY_APP_PASSWORD,
      store: tokens,
      catchUp: false,
    })
  );
}
if (process.env.THREADS_ACCESS_TOKEN) {
  channels.push(threadsChannel({ accessToken: process.env.THREADS_ACCESS_TOKEN, store: tokens }));
}
if (channels.length === 0) {
  console.error('\n  Set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD, or THREADS_ACCESS_TOKEN.\n');
  process.exit(1);
}

const agent = new Agent({
  name: 'social-assistant',
  model: 'google/gemini-3.8-flash',
  instructions: `You answer people who mention or reply to you on social media.
Be friendly and brief: a few sentences, no Markdown, links written out in full.`,
});

const cogitator = new Cogitator({
  llm: { defaultProvider: 'google', providers: { google: { apiKey: GOOGLE_API_KEY } } },
});

const gateway = new Gateway({
  agent,
  cogitator,
  channels,
  onError: (error, msg) => console.error(`Error answering ${msg.userId}:`, error.message),
});

await gateway.start();
console.log(
  `\n  Answering on ${channels.map((channel) => channel.type).join(' and ')}. Ctrl+C stops.\n`
);

process.on('SIGINT', async () => {
  await gateway.stop();
  await cogitator.close();
  process.exit(0);
});
