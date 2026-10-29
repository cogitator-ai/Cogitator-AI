---
'@cogitator-ai/core': patch
---

The core runs on Deno with only `--allow-net` and `--allow-env` again, as the edge docs promise. Importing it and creating a `Cogitator` read no file and ask for no system information until a feature needs them:

- The version that plugins' `engines.cogitator` ranges are checked against is read from `package.json` only when a plugin declares a range, and a runtime that cannot read it (Deno without `--allow-read`, edge runtimes without Node modules) loads the plugin without the check instead of failing on import. `PluginHostOptions.cogitatorVersion` also takes a function for that.
- The default `durable.owner` (`host:pid:random`) is worked out when a durable run first needs it, with `unknown-host` where the host name cannot be read, instead of in the constructor (Deno without `--allow-sys`).
- The plugin host looks up its default folder of installed plugins (`~/.cogitator/plugins`) only when it reads installed plugins or a plugin first uses its data folder, not when it is created. A plugin's data folder is worked out and created on first use (`context.plugin.dataDir`, a `${CLAUDE_PLUGIN_DATA}` reference, the environment of its hooks and MCP servers, an isolated process) instead of before every activation, and `PluginInfo.dataDir` is given once the folder of installed plugins is known or the plugin used its folder. The core's own plugins have no data folder, so a runtime with `installed: false` lists and runs the core plugin and code plugins that keep no data without asking for the home folder.
