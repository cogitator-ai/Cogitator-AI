---
'@cogitator-ai/bridge': minor
'@cogitator-ai/cli': minor
---

The bridge knows when an agent ran into the limit of its subscription or its key, and hands its jobs to another agent.

- A limit is read from what the harness itself says: the failure of a `codex exec` turn, a `StopFailure` hook of Claude Code for `rate_limit` and `billing_error` (installed by `cogitator bridge install` and carried by every session the bridge starts), and the rate limit and quota errors of a hosted agent's provider. `limitOf`, `limitResetOf` and `limitOfError` read the words and the time a limit is over.
- `limited(caller, { until, detail })` notes the harness as out of its limit until the time it named, or for `limits.limitRetryMs` (30 minutes) when it named none. `status().limited` lists them.
- No job goes to such a harness: `auto` passes it over, and a job addressed to it is refused with the new error code `limit_reached`.
- The jobs the session carried out go to a fresh session of another harness, in the same folder, with the job's number and letters kept, its time given anew and `redirects` on its record. A job nobody else can take fails with `failure: 'other'`.
- A limit ends when its time is over, when an agent of that harness finishes a job, or with `unlimit(agent)`. Of two limits of a harness the longer one stays.
- `routing.fallback` names harnesses of last resort, which take a job only when no other can.
- A step of a recipe that would go back to an agent whose harness is out of its limit goes to a fresh session of whoever takes jobs.
- Command line: `cogitator bridge limits [--clear <agent>]`, `cogitator bridge limited --hook claude-code`, `cogitator bridge serve --fallback <agent>` and `COGITATOR_BRIDGE_FALLBACK`. `status` and `log` show limits and jobs that were handed on.
- The stand-in of `claude` in `@cogitator-ai/bridge/testing` ends its turns on the API error `FAKE_CLAUDE_TURN_ERROR` names and runs the `StopFailure` hooks for it.
