---
'create-cogitator-app': minor
---

Generated servers now deploy healthy, and `scaffold()` can be embedded.

- The `api-server` template mounts its routes at `/api` but `cogitator deploy` probed `/cogitator/health`, so its containers were marked unhealthy. Its `cogitator.yml` now sets `deploy.health.path: /api/health`. The `nextjs` template gets a `/api/health` route and the same setting.
- `scaffold()` takes `install: false` to write the files without running `<pm> install`, and the CLI takes `--no-install`. It now resolves to a `ScaffoldResult` with the generated files and the outcome of the install and git steps, so a failed install is reported (`{ status: 'failed', error }`) instead of being swallowed. The CLI prints the error and adds the install command to the next steps.
- The `api-server` template installs express 5, matching its `@types/express` 5 typings and the express version `@cogitator-ai/express` is built against.
