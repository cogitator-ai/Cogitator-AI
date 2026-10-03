---
'@cogitator-ai/core': patch
'@cogitator-ai/types': patch
---

Counterfactuals now evaluate `custom` structural equations: `customFn` is an arithmetic expression over the parent node ids (numbers, `+ - * / ^`, parentheses, `abs exp log sqrt pow min max tanh sigmoid`), parsed without running code, with additive noise like `linear`. Nodes without an equation keep their observed value instead of a random noise sample.
