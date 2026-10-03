---
'@cogitator-ai/a2a': minor
---

`auth.validate` may return the caller (`{ userId }`) instead of `true`. Tasks then belong to the user who created them: other users get `Task not found` from `tasks/get`, `tasks/cancel`, the push-notification methods and attempts to continue the task, `tasks/list` returns only the caller's own tasks (`TaskFilter.visibleTo`), a `contextId` holding another user's tasks is refused, and runs carry the `userId` so threads and memory are scoped too. Returning `true` keeps every caller in one shared space as before. The push-notification `get`, `list` and `delete` methods now require the task to exist, like `create`.
