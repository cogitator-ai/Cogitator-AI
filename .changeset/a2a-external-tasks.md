---
'@cogitator-ai/a2a': minor
---

Tasks carried out outside the runtime. `TaskManager.advanceTask(taskId, { state, message })` moves a task that another process, a person or an agent of another runtime carries out through the usual lifecycle (`working`, `input-required`, `auth-required`, `completed`, `failed`, `rejected`), with the same events and the same store as a task a Cogitator agent runs. A task in a terminal state, or one a run of the manager is executing, does not move. `createTask` takes `metadata` to store with the new task in the same write.

The helpers a `TaskStore` of your own needs are exported: `isTaskVisibleTo`, `taskTime`, `taskCreatedAt` and `compareTasksNewestFirst`.
