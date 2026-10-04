---
'@cogitator-ai/memory': patch
---

Fixes in `MongoDBAdapter`, found by running it against a real MongoDB server for the first time:

- Fields left `undefined` are no longer stored as `null`. The driver serializes `undefined` as BSON null by default, so an entry saved without tool calls came back with `toolCalls: null`, `toolResults: null` and `metadata: null`, a message without a name came back with `name: null`, and a thread metadata key set to `undefined` was stored as `null`. Every other store leaves those fields out. The adapter now opens its client with `ignoreUndefined`, and entries an earlier version stored with those nulls read back without them, while a tool result that really is `null` stays `null`.
- A failed `connect()` leaves the adapter disconnected. It kept the half-open client, so the next `connect()` reported success while every call failed with `Not connected`. The failed client is now closed and the next `connect()` tries again, concurrent `connect()` calls share one attempt, and `disconnect()` waits for a pending one.
