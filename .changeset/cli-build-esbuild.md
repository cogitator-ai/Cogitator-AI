---
'@cogitator-ai/cli': patch
---

`cogitator build` bundles with its own esbuild, now a dependency of the CLI. It used to look for esbuild in the project and found it only when the package manager happened to hoist the copy that tsx brings along, so with pnpm's `hoist: false`, a globally installed CLI or a project without tsx it stopped with "esbuild is required". Projects can drop the `esbuild` dev dependency they added for it.
