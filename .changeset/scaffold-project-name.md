---
'create-cogitator-app': minor
---

The project name is validated as an npm package name before anything is written, both by the CLI and by `scaffold()`, and `validateProjectName(name)` is exported to check it up front. `.` names the project after the current directory instead of `"."`, and the name is quoted in the generated code, so a name like `bob's agents` is reported instead of producing code that does not compile.
