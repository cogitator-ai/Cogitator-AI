---
'@cogitator-ai/self-modifying': minor
---

Correct generated tools are no longer rejected, and a generated tool is reused instead of generated again.

- `ToolValidator` follows the reviewer's verdict. Any note in a review's `securityIssues` or `logicIssues` used to make the tool invalid and drop its score to 0, even when the review approved it, so with the default `requireLLMValidation: true` real models failed tools on minor remarks and the agent ran without one. An approving review now keeps the tool valid and its notes become `suggestions`. A review that recommends `revise` or `reject` still makes the tool invalid. Static security checks and failed sandbox tests stay authoritative whatever the review says.
- Without explicit test cases, the validator no longer requires a tool to succeed on synthesized placeholder input (such as `'test'` for every string), which failed tools that reject malformed input as the generation prompt asks. Synthesized inputs now only prove the tool runs. The generator asks the model for a few valid example inputs, and those must succeed.
- A generated tool is described by what it does. Its description used to be the gap text ("No available tool to compute ..."), so the next gap analysis decided the capability was still missing and generated a duplicate. The model now writes the description, an empty one or a copy of the gap text falls back to the gap's `requiredCapability`, and the gap analysis prompt says that listed tools, including generated ones, cover their capability.
- Gap analysis sees the agent's instructions (`GapAnalyzer.analyze(input, tools, { instructions })`, passed by `SelfModifyingAgent`), so a task the instructions require a tool for counts as a gap.
- New `config.maxInternalTokens` on `SelfModifyingAgent`, and `maxTokens` on `GapAnalyzer`, `ToolGenerator`, `ToolValidator`, `CapabilityAnalyzer` and `ParameterOptimizer`, bound the output tokens of their internal LLM calls, so reasoning models no longer spend minutes on them.
