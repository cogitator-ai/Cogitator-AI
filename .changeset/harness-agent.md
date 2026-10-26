---
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

- Presets `coding` (every workspace tool, subagents, commands, project instructions, 100 turns) and `assistant` (no shell, a `./workspace` folder, memory files when the runtime has memory, 30 turns). Every piece is an option: `false` turns it off, a value changes it, `agent` sets any other field of the `Agent`.
- The result is plain values: `agent`, `config` (the `Cogitator` fields the pieces need), `runOptions` (`parallelToolCalls`), `workspace`, `mergeConfig(base)` and `dispose()`.
- A project's own subagents, commands, hooks and allow rules apply only with `trusted: true`, settings files are read only with `settings: true`.
- `harnessPrompt(features)` builds the short system prompt section on the workspace, todos, subagents, deferred tools and approvals for an agent of your own.

Nothing changes for `Agent` and `Cogitator`: the harness only composes them.

create-cogitator-app: the `assistant` preset (the `harness` feature) builds its agent with `createHarnessAgent({ preset: 'assistant' })`. `src/harness/workspace.ts` is gone, `src/agents/assistant.ts` exports `createAssistant(workspace)` and `assistantHarness`, `src/cogitator.ts` merges the harness settings into `cogitator.yml`, and approvals before writes come from the permission engine.
