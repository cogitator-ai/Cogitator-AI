import 'dotenv/config';
import type { FeedChannel } from '@cogitator-ai/types';
import {
  BlueskyFeed,
  FeedPublisher,
  FilePublishStore,
  FileTokenStore,
  ThreadsFeed,
} from '@cogitator-ai/channels';

/**
 * One post to Bluesky and Threads: each feed gets the text fitted to its
 * limit, the publication is idempotent by key, and a second post waits
 * for its time in a store that survives restarts. Runs as a dry run unless
 * PUBLISH=1, so trying it posts nothing.
 */
const tokens = new FileTokenStore({ path: '.cogitator/tokens.json' });
const feeds: FeedChannel[] = [];

if (process.env.BLUESKY_HANDLE && process.env.BLUESKY_APP_PASSWORD) {
  feeds.push(
    new BlueskyFeed({
      identifier: process.env.BLUESKY_HANDLE,
      appPassword: process.env.BLUESKY_APP_PASSWORD,
      store: tokens,
    })
  );
}
if (process.env.THREADS_ACCESS_TOKEN) {
  feeds.push(new ThreadsFeed({ accessToken: process.env.THREADS_ACCESS_TOKEN, store: tokens }));
}
if (feeds.length === 0) {
  console.error('\n  Set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD, or THREADS_ACCESS_TOKEN.\n');
  process.exit(1);
}

const dryRun = process.env.PUBLISH !== '1';
const publisher = new FeedPublisher({
  feeds,
  store: new FilePublishStore({ directory: '.cogitator/feed-jobs' }),
  dryRun,
  onPublished: ({ feed, post }) => console.log(`  ${feed}: published ${post.url || post.id}`),
  onFailed: ({ feed, error, final }) =>
    console.log(`  ${feed}: ${final ? 'failed' : 'will retry'}: ${error.message}`),
});

console.log(dryRun ? '\n  Dry run: set PUBLISH=1 to post for real.\n' : '\n  Publishing.\n');

const today = new Date().toISOString().slice(0, 10);
const { job, duplicate } = await publisher.publish(
  {
    text: 'Open models now run on an ordinary laptop. What changed, and what it means for you:',
    link: {
      url: 'https://cogitator.app/docs/channels/feeds',
      title: 'Publishing to social feeds with Cogitator',
      description: 'Bluesky and Threads, with retries, schedules and idempotency',
    },
    tags: ['AI'],
    langs: ['en'],
  },
  { key: `example-story-${today}` }
);
console.log(duplicate ? '  Already published under this key.' : `  Job ${job.id}:`);
for (const delivery of job.deliveries) {
  console.log(`  - ${delivery.feed}: ${delivery.status}`);
}

const scheduled = await publisher.publish(
  { text: 'A scheduled follow-up, one minute later.' },
  { publishAt: Date.now() + 60_000, key: `example-follow-up-${today}` }
);
console.log(`\n  Scheduled ${scheduled.job.id}; waiting for it...`);

publisher.start();
await new Promise((resolve) => setTimeout(resolve, 75_000));
await publisher.stop();
for (const delivery of (await publisher.get(scheduled.job.id))?.deliveries ?? []) {
  console.log(`  - ${delivery.feed}: ${delivery.status}`);
}
for (const feed of feeds) await feed.close();
