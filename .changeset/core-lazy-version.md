---
'@cogitator-ai/core': patch
---

The core runs on Deno with only `--allow-net` and `--allow-env` again, as the edge docs promise. Importing it and creating a `Cogitator` read no file and ask for no system information until a feature needs them:

- The version that plugins' `engines.cogitator` ranges are checked against is read from `package.json` only when a plugin declares a range, and a runtime that cannot read it (Deno without `--allow-read`, edge runtimes without Node modules) loads the plugin without the check instead of failing on import. `PluginHostOptions.cogitatorVersion` also takes a function for that.
- The default `durable.owner` (`host:pid:random`) is worked out when a durable run first needs it, with `unknown-host` where the host name cannot be read, instead of in the constructor (Deno without `--allow-sys`).
- The plugin host looks up its default folder of installed plugins (`~/.cogitator/plugins`) when it first reads installed plugins, not when it is created. The core's own plugins get no `dataDir`, they keep nothing across updates.
