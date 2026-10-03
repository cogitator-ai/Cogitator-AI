---
'@cogitator-ai/workflows': minor
---

Approvals settle once. The first answer to a request wins in every store — in-memory, file, Redis and Postgres, atomically across processes — and a later `submitResponse` throws `ApprovalAlreadyAnsweredError` with the answer that stands; a human node whose timeout fires just after someone answered keeps that answer. Deleting (or expiring) a request nobody answered withdraws it: waiters, in this process or another, get a withdrawal and the node finishes with `withdrawn: true` instead of waiting forever. A timeout or withdrawal no longer counts as approval for `multi-choice` requests, where any decision value did.
