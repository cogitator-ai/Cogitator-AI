---
'@cogitator-ai/studio': minor
---

Rewind and fork threads from the memory tree. Every entry gets "Rewind here" and "Fork here" buttons: a rewind shows a dry run first (entries that leave the branch, stale memory items, runs that get dropped, and with "Restore files" the files written back and deleted), and a busy thread can be rewound by aborting its run. A fork opens a new thread that links back to its origin and shows the conversation it starts from. Rewound turns stay in the chat, faded, and are left out when a thread is replayed after a restart. User messages that name a file checkpoint are marked in the tree, and scripts get `POST /api/threads/:id/rewind` and `POST /api/threads/:id/fork`.
