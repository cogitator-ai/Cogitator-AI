---
'@cogitator-ai/workflows': patch
---

Cron triggers keep their timers straight in five more cases. A trigger whose timer wakes before the due time (the clock moved back) now waits for the due time instead of firing early and then firing the same occurrence again. A trigger that waits longer than one timer can (more than about 24.8 days) keeps its timer under its own id, so `disable()`, `unregister()` and `dispose()` stop it, before a disabled trigger still fired. An expression with a seconds field such as `* * * * * *` is checked every second, before it fired once a minute. Registering or enabling a trigger from inside `onFire` no longer leaves a second check interval behind after `dispose()`. A `condition` or `input` function that throws is counted as a failed fire (`errorCount`, `lastError`) and the trigger stays scheduled, before it was an unhandled rejection and the trigger never fired again.
