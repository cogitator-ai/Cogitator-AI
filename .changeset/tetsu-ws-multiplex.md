---
'@cogitator-ai/tetsu': minor
---

Tetsu's WebSocket runs several agents, workflows and swarms per socket and keeps every frame under backpressure

A socket now runs side by side the runs its frames start with different `id`s, up to `websocket.maxRuns` (8 by default, one more gets `TOO_MANY_RUNS`). A run with the `id` of one still going, or a second one without an `id`, still gets `RUN_IN_PROGRESS`. `stop` with an `id` cancels that run, `stop` without one cancels every run of the socket, as it cancelled the only one before. A `stop` whose `id` matches no run now does nothing, where it used to cancel the only run, so a client that stops by `id` must send the `id` of the run. A duplicate `id` gets the message `A run with id '<id>' is already in progress`, and `code` stays `RUN_IN_PROGRESS`.

The runs of a socket share the `deps` built at the handshake and now run at the same time, also two runs on the same thread, so `deps` holding a connection or transaction must be safe for concurrent use. `maxRuns` and `maxBufferedBytes` hold per socket: cap sockets or runs per user in `auth` or a rate limiter.

A stop answers `cancelled` at once, also for a workflow whose node is still running, and the run sends nothing after it. Its `id` is free for a new run at once, and it keeps its place among the `maxRuns` until it actually ends.

Frames are no longer lost in silence under backpressure. Once Bun reports it, the frames after it wait in order and go out as the socket drains. When more than `websocket.maxBufferedBytes` wait (4 MiB by default), or Bun drops a frame, the socket is closed with `1008`, which cancels its runs. Both options must be positive integers, or building the controller throws.
