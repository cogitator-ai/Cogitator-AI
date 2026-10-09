---
'@cogitator-ai/channels': minor
'@cogitator-ai/types': minor
---

Bluesky and Threads, for publishing posts and for talking with people.

- `BlueskyFeed` and `ThreadsFeed` publish posts with a link card, images with alt text, tags, languages and replies, and check each post against the feed's limits before sending it: 300 graphemes and 3000 bytes on Bluesky, 500 characters with emoji counted by their UTF-8 bytes on Threads. Links, mentions and hashtags become clickable facets on Bluesky, and Threads posts go through a media container that is published once Threads reports it ready.
- `FeedPublisher` sends one post to several feeds, now or at `publishAt`. Each feed is tracked on its own, so one failing feed does not stop the others. A delivery keeps the feed's idempotency key from before its first attempt, so an attempt after a crash or a lost answer finds the post instead of publishing it twice. Rate limits and a feed that is down are retried with backoff, a full Threads quota is waited out without spending attempts, the same `key` publishes once, text longer than a feed takes is cut at a word for that feed, and `dryRun` goes through every step but publishing.
- A publisher takes one due job at a time, extends its claim while it works and saves only while the claim is its own, so a worker that lost its claim never overwrites the one that took over.
- Jobs live in `MemoryPublishStore`, `FilePublishStore` or `PostgresPublishStore`, which lets several workers share them with `FOR UPDATE SKIP LOCKED` claims. Sessions and tokens live in `MemoryTokenStore`, `FileTokenStore` (an owner-only file, shared safely by the stores of one process) or `PostgresTokenStore`.
- The Threads long-lived token renews itself a week before it expires, once for calls made at the same time and once for processes sharing a store. A failed renewal keeps the current token and tries again an hour later.
- `BlueskyChannel` answers mentions, replies, quotes and direct messages through the Gateway, conversation requests included. `ThreadsChannel` answers replies and mentions, from signed webhooks or by polling. Long answers go out as threads of posts, and Markdown becomes plain text.
- Channels with `editable: false` get finished answers from the Gateway instead of streamed edits, since Bluesky and Threads cannot edit posts. `markdownToPlainText` is exported.
- `cogitator.yml` takes `channels.bluesky` and `channels.threads`, read from `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD` and `THREADS_ACCESS_TOKEN`.
- `@cogitator-ai/types` adds `FeedChannel` (with `idempotencyKey()` and `FeedPublishOptions`), `FeedPost`, `PublishedPost`, `FeedLimits`, `TokenStore` and `StoredToken`, the `bluesky` and `threads` channel types and `Channel.editable`.

`@atproto/api` is an optional peer dependency, needed only for Bluesky.
