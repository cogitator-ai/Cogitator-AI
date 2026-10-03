---
'@cogitator-ai/swarms': minor
'@cogitator-ai/types': patch
---

The assessor honours `mode: 'ai' | 'hybrid'` and `assessorModel`: inside a Swarm the model (default: the Cogitator's default model) analyzes the task, 'hybrid' adds the hard requirements the keyword rules detect, and any failure falls back to the rules with a warning. Model discovery inside a Swarm only offers cloud models whose provider the Cogitator can run, instead of suggesting providers without an API key. `createAssessor(config, cogitator)` takes the Cogitator for the same behaviour standalone.
