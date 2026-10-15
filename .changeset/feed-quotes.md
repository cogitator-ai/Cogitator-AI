---
'@cogitator-ai/channels': minor
'@cogitator-ai/types': minor
---

Posts can quote other posts: `FeedPost.quote` is the id of a post of the same feed to show inside the new one.

- Bluesky embeds the quoted post as `app.bsky.embed.record`, or together with the post's images or link card as `app.bsky.embed.recordWithMedia`. The feed finds the quoted post's `cid` itself, from the posts it published, the account's own PDS or the AppView, and a quote can be a reply too.
- Threads passes it as `quote_post_id` in text, image and carousel posts and in replies. Threads accepts a link card in a quote post but does not show it, so the feed leaves `link` out of a post that quotes, and a retry by idempotency key matches a quote post by the post it quotes.
- An id that is not a post of the feed (an `at://` post URI on Bluesky, a media id on Threads) fails with `invalid_post` before anything is sent.
