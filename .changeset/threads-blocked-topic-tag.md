---
'@cogitator-ai/channels': patch
---

`ThreadsFeed` publishes a post without its topic tag when Threads blocks tagging for the account (Graph API error subcode 2207051), instead of failing the post for good. The same post without the tag goes out, a warning says the tag was dropped, and a retry with the same idempotency key takes the untagged post for its own. `FeedError` carries the platform's `subcode` where it gives one.
