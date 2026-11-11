---
'@cogitator-ai/channels': patch
---

`ThreadsFeed` no longer loses a post when Threads refuses its link card on publication ("invalid link attachment", error subcode 4279047), a fault that passes. It waits `linkRetryDelays` (a minute, then five seconds), looks the post up since Threads may have published it all the same, and publishes it again from a new container. After the last wait a post with a `link` goes out with the link at the end of its text, with a warning. A post still refused fails as `unavailable`, which `FeedPublisher` tries again later, instead of `invalid_post`.
