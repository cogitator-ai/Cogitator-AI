---
'create-cogitator-app': minor
'@cogitator-ai/cli': patch
---

The telemetry event of a failed scaffold says where and why it failed. `failedStep` is `create` (the options, the directory, downloading or writing files) or `install`, and `errorCode` is the code it failed with: the package manager's own (`ERR_PNPM_NO_MATCHING_VERSION`, npm's `ETARGET`, Yarn's `YN0035`, a code for the messages of Bun and Yarn 1), a Node network or file system code (`ENOTFOUND`), or the scaffolder's (`DIRECTORY_NOT_EMPTY`, `HTTP_404`). Both are `none` on success. The event never holds the error message or the install output, which can contain paths and package names.

An `--example` or `--template` whose install failed was counted as a success. It is a failure now, like a generated project.

In the library, `payloadFor(spec, failure?, kind)` takes a `ScaffoldFailure` (`{ step, error }`) in place of the outcome, and `installFailure(result)` gives the one of a scaffold whose install failed. `telemetryErrorCode`, `installErrorCode` and `CodedError`, the error with a code the scaffolder throws, are exported too.
