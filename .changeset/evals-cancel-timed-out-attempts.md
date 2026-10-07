---
'@cogitator-ai/evals': minor
---

A timed-out eval attempt is now cancelled instead of abandoned. The suite aborts an `AbortSignal` per attempt: an agent target gets it as `cogitator.run(agent, { input, context, signal })`, so its run stops instead of finishing and paying in the background, and a `fn` target is called as `fn(input, { signal, case, attempt })`. The suite waits for a cancelled attempt to stop (at most another `timeout`) before it retries, so attempts of one case never overlap and `concurrency` holds. `suite.run({ signal })` and `comparison.run({ signal })` cancel a whole run, which then rejects with the signal's reason.
