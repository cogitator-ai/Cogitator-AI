---
'@cogitator-ai/swarms': minor
---

Negotiation approval gates work inside a `Swarm`: a gate without `timeout` now waits for an answer instead of being rejected at once, and the new `swarm.respondToApproval(requestId, response)` answers it (the id comes with the `negotiation:approval-required` event). A swarm timeout or `swarm.abort()` stops the wait. Gates on a deadlock were also cancelled the moment they were raised; they now wait for their answer or timeout.
