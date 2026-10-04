---
'@cogitator-ai/workflows': minor
'@cogitator-ai/types': minor
---

A human approval wait survives a restart. A request got a random id, so a run picked up again after a crash asked the same question twice and lost an answer given while the process was down. A request's id now comes from the run and the question, so a human node that runs again finds its own request: an answer given in the meantime is used at once, an open request is waited on without a second notification, and the timeout keeps counting from the original deadline. A node visited again in a loop asks about a changed state and opens a new request. `WorkflowManager.recoverRuns(options)` resumes the runs a stopped process left running or waiting from their last checkpoint. An escalation's id comes from the request it escalates and it keeps its own deadline, so a pending escalation is picked up too. `resume`, `replay` and `recoverRuns` start from the newest checkpoint saved for the run, even one the run record never heard of because the process stopped mid-flight.
