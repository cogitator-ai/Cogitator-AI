---
'@cogitator-ai/channels': minor
'@cogitator-ai/types': minor
'@cogitator-ai/cli': minor
'create-cogitator-app': minor
---

Channels: a GitHub channel, so an agent answers issues, pull requests, comments and code reviews.

- `githubChannel({ token, webhook: { secret, port } })` takes events from a repository or organization webhook: opened issues and pull requests, issue and pull request comments, reviews with a body and comments on lines of a diff. Every delivery is checked against `X-Hub-Signature-256` with the webhook secret, answered at once and handled after, and each `X-GitHub-Delivery` is handled once. It runs a webhook server of its own on `port` (bodies up to 1 MB), or `handleWebhook` is mounted in any HTTP server with the raw body.
- Each issue or pull request is a conversation, `channelId` `owner/repo#number`, answered with a comment on it. A comment on a line is answered in its review thread, which is the message's `topicId`, so every review thread is a conversation of its own.
- By default the bot answers only mentions of `@login` (outside code and quotes), `trigger: 'all'` answers every event, and `repositories` limits it to `owner/repo` or `owner/*`. It skips its own comments and other bots unless `allowBots` is set.
- Answers are sent finished, since GitHub notifies people of a comment's first text, and `stream: true` streams them into a comment it edits. Answers past 65536 characters go out as several comments. `setReaction` uses GitHub's eight reactions and replaces the bot's earlier one, and `sendFile` links files with a public URL, as GitHub has no upload API for comments.
- `token` takes a function too, for GitHub App installation tokens that expire, with `login` set to `<app-slug>[bot]`. `apiUrl` points it at GitHub Enterprise Server. REST errors are `FeedError`s with `retryAfter` from `Retry-After` or the rate limit reset.
- `ChannelType` includes `'github'`. In `cogitator.yml`, `channels.github` reads `GITHUB_TOKEN` and `GITHUB_WEBHOOK_SECRET`, and `cogitator init`, `cogitator wizard` and create-cogitator-app (`--channels github`) set it up.
