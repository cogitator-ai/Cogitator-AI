---
'create-cogitator-app': minor
---

A freshly scaffolded project now runs on the first try. The `dev` and `start` scripts load `.env` (`tsx --env-file-if-exists=.env`), so a key copied from `.env.example` reaches the app instead of failing with `OpenAI API key is required`, and a missing key stops the app with its name and a pointer to `.env.example`. `npx create-cogitator-app` now picks npm instead of pnpm. The default Ollama model is `qwen3.5:9b`, the prompt lists the models already pulled, `--model` and `ProjectOptions.model` choose another one, a missing model is offered for download, and the compose file pulls it into the Ollama container. The printed next steps and the generated README include `cp .env.example .env` or `ollama pull <model>` when the first run needs them.
