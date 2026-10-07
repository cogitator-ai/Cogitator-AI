---
'@cogitator-ai/types': minor
---

Adds `RunObserver` and `CogitatorConfig.observers`. `WorkflowNode.fn` and the compensation hooks are declared as methods, so a `Workflow<MyState>` is assignable to `Workflow` and workflows with different states share one registry, such as the `workflows` option of the server adapters.
