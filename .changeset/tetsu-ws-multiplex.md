---
'@cogitator-ai/tetsu': minor
---

Tetsu's WebSocket runs several agents, workflows and swarms per socket and keeps every frame under backpressure

A socket now runs side by side the runs its frames start with different `id`s, up to `websocket.maxRuns` (8 by default, one more gets `TOO_MANY_RUNS`). A run with the `id` of one still going, or a second one without an `id`, still gets `RUN_IN_PROGRESS`. `stop` with an `id` cancels that run, `stop` without one cancels every run of the socket, as it cancelled the only one before.

A stop answers `cancelled` at once, also for a workflow whose node is still running, and the run sends nothing after it. It keeps its place among the `maxRuns` until it actually ends.

Frames are no longer lost in silence under backpressure. Once Bun reports it, the frames after it wait in order and go out as the socket drains. When more than `websocket.maxBufferedBytes` wait (4 MiB by default), or Bun drops a frame, the socket is closed with `1008`, which cancels its runs. Both options must be positive integers, or building the controller throws.
