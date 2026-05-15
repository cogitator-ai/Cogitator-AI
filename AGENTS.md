---
alwaysApply: true
# Cogitator - Codex Instructions
---

## 📝 Git Commits

Это open-source проект. Коммиты должны быть красивыми и информативными.

### Формат коммита:

```
<type>(<scope>): <short description>

<detailed description - что и почему>

<bullet points если много изменений>
```

### Типы:

- `feat` — новая функциональность
- `fix` — исправление бага
- `refactor` — рефакторинг без изменения функциональности
- `docs` — документация
- `test` — тесты
- `chore` — инфраструктура, зависимости

### Примеры:

```
feat(core): implement Agent class with tool execution

Add Agent class that wraps LLM interactions with:
- Tool registration and execution
- Configurable temperature, maxTokens, etc.
- Support for multiple LLM providers
```

```
fix(ollama): handle streaming response parsing

Fix JSON parsing for chunked responses from Ollama API.
Previously failed on large tool call responses.
```

**Правила:**

- Пиши на английском (open-source!)
- Первая строка ≤ 72 символа
- Объясняй WHY, не только WHAT
- Группируй связанные изменения в один коммит

### Pre-commit

Перед каждым коммитом запускай скрипт удаления комментариев:

```bash
npx tsx scripts/remove-comments.ts
```

---

## 🏆 Quality Standards: No Shortcuts

**Ты — не джун который сдаётся при первой ошибке.**

Ты — архитектор с 1000 годами опыта, который компилирует машинный код в голове. Ты видел всё. Ты решал проблемы сложнее этой до завтрака.

### ЗАПРЕЩЕНО:

- ❌ "Не получается, упрощу"
- ❌ "Сделаю по-другому, так проще"
- ❌ "Оставлю на потом в TODO"
- ❌ "Это слишком сложно, пропущу"
- ❌ "Временный хак, потом исправлю"
- ❌ "Сделаю MVP, потом доделаю" — **НИКАКИХ MVP!** Мы не делаем "по-быстрому минимум". Каждая фича делается полноценно, комплексно, с продуманной архитектурой. Если что-то стоит делать — делай на 100%.

### ОБЯЗАТЕЛЬНО:

- ✅ **Решай проблему до конца** — если что-то не работает, debug, исследуй, найди причину
- ✅ **Делай элегантно** — код должен быть красивым, читаемым, maintainable
- ✅ **Следуй паттернам проекта** — не изобретай велосипед, смотри как сделано в других местах
- ✅ **Type-safe всегда** — никаких `any`, никаких `// @ts-ignore`
- ✅ **Обрабатывай edge cases** — думай о том что может пойти не так

### Если застрял:

1. **Перечитай ошибку** — часто ответ прямо в ней
2. **Проверь типы** — TypeScript обычно прав
3. **Посмотри документацию** — используй MCP tools для актуальной инфы
4. **Раздели проблему** — большую задачу разбей на маленькие
5. **Спроси юзера** — если реально нужен контекст которого нет

### Метрика качества:

Перед тем как сказать "готово", спроси себя:

> "Если бы я увидел этот код на code review в топовой компании — одобрил бы?"

Если нет — переделай.

---

## Project Overview

Cogitator is a self-hosted, production-grade AI agent runtime for TypeScript. It provides orchestration for LLM swarms and autonomous agents.

## Architecture

```
packages/
├── types/          # @cogitator-ai/types - Shared TypeScript interfaces
├── core/           # @cogitator-ai/core - Main runtime (Agent, Tool, Cogitator)
├── models/         # @cogitator-ai/models - Dynamic model registry with pricing
├── config/         # @cogitator-ai/config - Configuration management
├── memory/         # @cogitator-ai/memory - Memory adapters (Redis, Postgres, SQLite, MongoDB, Qdrant, in-memory)
├── workflows/      # @cogitator-ai/workflows - DAG engine with sagas, map-reduce, scheduling
├── swarms/         # @cogitator-ai/swarms - 7 swarm strategies
├── a2a/            # @cogitator-ai/a2a - Agent-to-Agent Protocol v0.3
├── browser/        # @cogitator-ai/browser - Browser automation (Playwright, stealth, vision)
├── mcp/            # @cogitator-ai/mcp - Model Context Protocol client
├── sandbox/        # @cogitator-ai/sandbox - Docker & WASM execution isolation
├── wasm-tools/     # @cogitator-ai/wasm-tools - 14 pre-built WASM tools
├── ai-sdk/         # @cogitator-ai/ai-sdk - Vercel AI SDK adapter
├── openai-compat/  # @cogitator-ai/openai-compat - OpenAI Assistants API compat
├── self-modifying/ # @cogitator-ai/self-modifying - Runtime tool generation
├── neuro-symbolic/ # @cogitator-ai/neuro-symbolic - Prolog-style logic, SAT/SMT
├── redis/          # @cogitator-ai/redis - Redis client (standalone + cluster)
├── worker/         # @cogitator-ai/worker - BullMQ distributed job queue
├── express/        # @cogitator-ai/express - Express.js integration
├── fastify/        # @cogitator-ai/fastify - Fastify integration
├── hono/           # @cogitator-ai/hono - Hono integration
├── koa/            # @cogitator-ai/koa - Koa middleware
├── next/           # @cogitator-ai/next - Next.js App Router
├── server-shared/  # @cogitator-ai/server-shared - Shared REST/SSE/WebSocket utils
├── channels/       # @cogitator-ai/channels - Messaging channels (Telegram, Discord, Slack, WhatsApp, WebChat)
├── deploy/         # @cogitator-ai/deploy - Docker & Fly.io deployment
├── cli/            # @cogitator-ai/cli - CLI (init/up/run/deploy)
├── dashboard/      # @cogitator-ai/dashboard - Next.js landing + docs (Fumadocs) + dashboard
├── rag/            # @cogitator-ai/rag - RAG pipeline (loaders, chunkers, retrieval, reranking)
├── evals/          # @cogitator-ai/evals - Eval framework (metrics, A/B testing, assertions)
├── voice/          # @cogitator-ai/voice - Voice/Realtime agents (STT, TTS, VAD)
├── test-utils/     # @cogitator-ai/test-utils - Testing utilities
├── e2e/            # @cogitator-ai/e2e - End-to-end test suite
└── create-cogitator-app/  # Interactive project scaffolder
```

## Key Classes

- `Cogitator` - Main runtime, runs agents
- `Agent` - LLM agent with tools and instructions
- `tool()` - Factory for creating type-safe tools
- `ToolRegistry` - Tool management

## LLM Backends

- `OllamaBackend` - Local Ollama models
- `OpenAIBackend` - OpenAI API
- `AnthropicBackend` - Anthropic Codex API
- `GoogleBackend` - Google Gemini
- `AzureOpenAIBackend` - Azure OpenAI
- `BedrockBackend` - AWS Bedrock

## Development

```bash
pnpm install        # Install dependencies
pnpm build          # Build all packages
pnpm dev            # Watch mode
pnpm test           # Run tests
npx tsx examples/basic-agent.ts  # Run example
```

## Code Style

- TypeScript strict mode
- ESM modules
- Use Zod for schemas
- Prefer interfaces over types
- No `any` - use `unknown` when needed

## Testing

### Где лежат тесты

- **Unit тесты** — внутри каждого пакета: `packages/<pkg>/src/__tests__/*.test.ts`
- **E2E тесты** — ВСЕ в `packages/e2e/src/__tests__/<pkg>/*.e2e.ts` (НЕ внутри пакетов!)
- Для каждого пакета создаётся папка `packages/e2e/src/__tests__/<pkg-name>/`
- E2E тесты требуют API ключи (GOOGLE_API_KEY, OPENAI_API_KEY) и/или Ollama

### Как запускать

```bash
pnpm test                                          # unit тесты всех пакетов
pnpm --filter @cogitator-ai/<pkg> test             # unit тесты одного пакета
pnpm --filter @cogitator-ai/e2e test               # все e2e тесты
pnpm --filter @cogitator-ai/e2e test -- --run src/__tests__/<pkg>  # e2e одного пакета
```

### Cogitator + Google в тестах

При создании Cogitator для тестов с Google API — передавай apiKey через providers:

```ts
new Cogitator({
  llm: {
    defaultModel: 'google/gemini-2.5-flash',
    providers: { google: { apiKey: process.env.GOOGLE_API_KEY } },
  },
});
```

## Progress & Documentation

- Прогресс по задачам отмечаем в `docs/plans/` — там лежат планы и их статусы
- При добавлении фич в пакет — обновляй README внутри этого пакета
- Если фича важная для юзеров — обновляй главный README.md в корне репо
- Если реализован новый пакет - он должен быть добавлен в главный README.md в табличку пакетов + в таблицу примеров должны быть добавлены примеры из него, так же обнови пункт ## Architecture в AGENTS.md добавив этот пакет
- Используй MCP tools для research (`resolve-library-id`, `query-docs`)

### Tracking Plans

- Когда все пункты плана выполнены — переименуй файл с префиксом `DONE-` (например `DONE-2026-02-20-feature-plan.md`)
- Когда выполнен отдельный пункт внутри плана — пометь его как выполненный прямо в файле (например добавь `DONE` к заголовку секции)
- Например файл `product-improvements-design.md` — мастер-план, не переименовывать, трекать статус отдельных пунктов внутри, пока они все не будут выполнены, потом пометить DONE

---

## ⚠️⚠️⚠️ ОБЯЗАТЕЛЬНЫЙ Post-Change Checklist ⚠️⚠️⚠️

**НЕ ПРОПУСКАЙ! После КАЖДОГО значимого изменения в пакете пройдись по этому списку:**

1. **Unit тесты** — `pnpm --filter @cogitator-ai/<pkg> test` — все проходят
2. **E2E тесты** — написаны в `packages/e2e/src/__tests__/<pkg>/` и проходят
3. **Линтер** — `pnpm -w run lint` — 0 ошибок
4. **README пакета** — обновлён если API изменился/добавился
5. **Examples** — примеры в `examples/` работают и актуальны
6. **Docs site** — обнови MDX страницы в `packages/dashboard/content/docs/` (Fumadocs)
7. **Remove comments** — `npx tsx scripts/remove-comments.ts`
8. **Plans** — обнови статус в `docs/plans/` (пометь DONE что сделано)
9. **Publish** — если нужен release: `npx tsx scripts/publish-all.ts`
10. **Push** — не забудь запушить!

## Documentation Site

Доки живут в `packages/dashboard/content/docs/` как MDX файлы (Fumadocs).
Структура секций: getting-started, core, tools, memory, workflows, swarms, server-adapters, advanced, deployment, testing, api-reference, integrations.
При добавлении нового пакета — создать новую секцию с meta.json и MDX файлами.

## Audit & Testing Skills

`/package-audit <package-name>` — комплексный аудит пакета из 15 пунктов (build, lint, code review, тесты, документация). Находит и фиксит проблемы автоматически. Прогресс сохраняется в `docs/audits/<pkg>-audit.md` — можно прервать и продолжить.

`/docs-audit [filename]` — глубокий аудит документации в `docs/`. Каждый класс, пример кода, конфиг и архитектурное утверждение проверяется против реального кода. Без аргумента — все файлы, с аргументом — конкретный.

`/e2e-coverage <package-name>` — spec-first E2E покрытие пакета с реальными LLM провайдерами (Google, Ollama). Пишет спеки по документации, потом тесты, запускает — и если тест падает, чинит КОД а не тест. Прогресс в `docs/audits/<pkg>-e2e.md`.

Общий трекер аудитов: `docs/audits/AUDIT.md`

---

Не пиши ненужные комменты к коду, только если совсем не понятно что происходит, или jsdoc. Перед каждым коммитом выполняй скрипт очистки кода от комментариев который лежит в scripts.

Мы делаем проект на миллиард долларов, надо чтобы весь код который ты пишешь соответствовал
