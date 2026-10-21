---
'@cogitator-ai/openai-compat': minor
---

Run steps and threads scoped to the API key.

- Runs record their steps as the Assistants API does: a `tool_calls` step per model turn that called tools, with each call's output once known, and a `message_creation` step for the message the run wrote, with usage and the run's error when it stops early. `GET /v1/threads/:thread_id/runs/:run_id/steps` lists them (with `limit`, `order`, `after`, `before`) and `GET .../steps/:step_id` reads one. Streaming runs emit `thread.run.step.created`, `in_progress`, `delta` and `completed` in the order the OpenAI SDK expects.
- When the server checks API keys, threads and runs belong to the key that created them, kept as a digest, never the key itself. Another key gets `404` for them, their messages, runs and steps. Threads created before this change stay reachable by every key. Assistants, files and responses stay shared.
- `ThreadStorage.listThreads(options)` returns a page (`{ threads, nextCursor? }`) filtered by owner and ordered by creation time, instead of every thread: storage implementations of your own need to follow. Postgres pages in SQL with a new index, Redis reads every thread key per page.
- A message a run had begun to stream is kept as `incomplete` when the run is cancelled, expires or fails.
