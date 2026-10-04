---
'@cogitator-ai/core': patch
'@cogitator-ai/swarms': patch
'@cogitator-ai/server-shared': patch
'@cogitator-ai/fastify': patch
'@cogitator-ai/config': patch
'@cogitator-ai/deploy': patch
'@cogitator-ai/mcp': patch
'@cogitator-ai/memory': patch
'@cogitator-ai/neuro-symbolic': patch
'@cogitator-ai/openai-compat': patch
'@cogitator-ai/self-modifying': patch
'@cogitator-ai/a2a': patch
---

Close the code scanning findings that were real. `webScrape` decodes each HTML entity once (an escaped `&amp;lt;` no longer turns into `<`), removes `script` and `style` blocks whose closing tag carries whitespace or attributes, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
