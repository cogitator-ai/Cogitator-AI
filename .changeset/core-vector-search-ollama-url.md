---
'@cogitator-ai/core': patch
---

The `vector_search` tool reads the Ollama endpoint from `OLLAMA_URL` too (after `OLLAMA_BASE_URL`, before `OLLAMA_HOST`), as the config loader does. `sql_query` reads `DATABASE_URL` safely where the environment is not readable.
