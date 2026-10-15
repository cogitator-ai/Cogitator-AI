---
'@cogitator-ai/channels': patch
---

`ThreadsFeed` no longer loses a post when Threads answers that a container it just reported ready cannot be found (Graph API code 24). That answer passes within seconds, so the feed publishes again after short waits (`publishRetryDelays`, 2, 5 and 10 seconds by default), and reads the container's status before each try: a container that did go out is looked up among the account's posts instead of being published twice. A post with neither text nor alt text cannot be told apart there, so it fails as `unknown` rather than taking another post's id, and a lookup without an idempotency key never takes a post the feed published before. A container still not found fails as `unavailable`, so `FeedPublisher` tries the post again later. `FeedError` carries the platform's own error code in `platformCode`, and Graph API code 24 maps to `not_found`.
