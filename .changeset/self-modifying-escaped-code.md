---
'@cogitator-ai/self-modifying': patch
---

Reject generated tools whose code does not compile, and repair code a model escaped twice. A compile error in the sandbox was reported as an error thrown by the tool, so the validator accepted a tool that could never run as long as its checks allowed a descriptive error. Code that arrives on one line with literal `\n` sequences is now unescaped once when that makes it compile.
