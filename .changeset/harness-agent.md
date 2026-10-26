---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
'create-cogitator-app': minor
---

`createHarnessAgent()` assembles a production agent from the pieces the runtime has, in one call: a workspace with file tools (and `run_command` for coding), `write_todos`, `SKILL.md` skills, Markdown subagents with a built-in `general-purpose` one and commands, `AGENTS.md` project instructions, the permission engine in `default` mode, compaction, long tool results saved to the workspace past 30 000 characters, `tool_search` once an agent has more than 20 tools, and parallel read-only calls.

```ts
const harness = createHarnessAgent({ preset: 'coding', workspace: './my-app' });
const cog = new Cogitator(
  harness.mergeConfig({ llm: { defaultModel: 'anthropic/claude-sonnet-5-5' } })
);
await cog.run(harness.agent, { input: 'Fix the failing test', ...harness.runOptions, onApproval });
```

- Presets `coding` (every workspace tool, subagents, commands, project instructions, 100 turns) and `assistant` (no shell, a `./workspace` folder, memory files once the runtime has a memory adapter, given to the harness or in the config `mergeConfig()` merges into, 30 turns). Every piece is an option: `false` turns it off, a value changes it, `agent` sets any other field of the `Agent`.
- The result is plain values: `agent`, `config` (the `Cogitator` fields the pieces need), `runOptions` (`parallelToolCalls`), `workspace`, `mergeConfig(base)` and `dispose()`. `mergeConfig` merges deep: the preset's defaults give way to your config, your `createHarnessAgent()` options win over it, maps such as `subagents.agents` merge by key.
- A project's own subagents, commands, hooks and allow rules apply only with `trusted: true`, settings files are read only with `settings: true`, both from `projectRoot` on this machine: the root of a `LocalWorkspace` by default, the host directory of a `DockerWorkspace` when you pass it, none for a remote workspace. `permissions: false` with `settings: true` reads the hooks and leaves the permission engine off.
- `AgentConfig.deferredTools` names tools whose schemas wait for `tool_search` without changing the tools, so a tool other agents share stays as it is. The harness defers your tools this way once the model would see more than 20 tools, its built-in ones counted.
- `harnessPrompt(features)` builds the short system prompt section on the workspace, todos, subagents, deferred tools and approvals for an agent of your own.

Existing agents and runtimes run as before: the harness composes them, and `deferredTools` is a new optional field.

create-cogitator-app: the `assistant` preset (the `harness` feature) builds its agent with `createHarnessAgent({ preset: 'assistant' })`. `src/harness/workspace.ts` is gone, `src/agents/assistant.ts` exports `createAssistant(workspace)` and `assistantHarness`, `src/cogitator.ts` merges the harness settings into `cogitator.yml`, and approvals before writes come from the permission engine.
