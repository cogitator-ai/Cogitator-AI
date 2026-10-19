---
'create-cogitator-app': patch
---

Projects created for Yarn 2 and later work out of the box. They get a `.yarnrc.yml` with `nodeLinker: node-modules`, because under Yarn's default Plug'n'Play tsx, vitest and Cogitator Studio could not find their packages, and the `.gitignore` entries Yarn recommends for `.yarn/`. Projects pinned to Yarn 1 get no `.yarnrc.yml`, Yarn 1 never reads it. Generated projects also declare `vite`, which vitest needs as a peer and which Yarn, unlike npm, pnpm and Bun, does not install by itself, so `yarn test` failed. The first install no longer fails under CI with Yarn 4, which refused to write the lockfile there (`YN0028`).
