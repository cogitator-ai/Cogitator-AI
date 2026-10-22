---
'@cogitator-ai/types': minor
'@cogitator-ai/server-shared': minor
'@cogitator-ai/express': minor
'@cogitator-ai/fastify': minor
'@cogitator-ai/hono': minor
'@cogitator-ai/koa': minor
'@cogitator-ai/tetsu': minor
---

Workflow checkpoints and resume over HTTP in every REST adapter

With the new `workflowCheckpoints` option (a `CheckpointStore`), a workflow run accepts `options.checkpoint: true` and saves checkpoints there. A finished run answers with its `checkpointId`, and a failed one carries it in the error answer, next to `code` and `message`, and in a `workflow_failed` event before the stream's `error` event. `POST /workflows/:name/resume` and `/workflows/:name/resume/stream` take `{ checkpointId, options? }` and run the remaining nodes, with the server's limits, the caller's auth and the same answers as `/run` and `/stream`. A resumed run saves checkpoints too, so it can be resumed again.

A checkpoint belongs to the user who ran the workflow: `WorkflowCheckpoint` gets an `owner`, set through `ownedCheckpoints(store, owner)` from server-shared. Another user's checkpoint, one of another workflow, an unknown id and a server without a store all answer `404 CHECKPOINT_NOT_FOUND`, a new error code, before anything runs. Without `workflowCheckpoints`, `options.checkpoint: true` is still refused. OpenAPI documents the resume routes, `WorkflowResumeRequest` and `checkpointId`, and the conformance cases cover the refusals.
