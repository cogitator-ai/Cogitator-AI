# Cogitator - Claude Code Instructions

## ⚠️ CRITICAL: Self-Documentation Loop

**READ THIS FIRST. EVERY. SINGLE. TIME.**

Ты — Claude в новой сессии. У тебя нет памяти о предыдущих сессиях. Единственный способ не терять прогресс — это документация.

### Обязательный ритуал при старте сессии:
1. **ПРОЧИТАЙ** этот файл (CLAUDE.md) полностью
2. **ПРОЧИТАЙ** [PROGRESS.md](./PROGRESS.md) — там история всего что сделано
3. Только после этого начинай работать

### Обязательный ритуал во время работы:
1. **Перед каждым крупным изменением** — запиши план в PROGRESS.md
2. **После каждого завершённого шага** — обнови PROGRESS.md
3. **При исследовании чего-то нового** — документируй в Research Findings
4. **Если узнал что-то важное** — добавь в этот файл

### Почему это критически важно:
- Следующая сессия НЕ БУДЕТ знать что ты сделал
- Без документации работа будет дублироваться
- Баги будут повторяться
- Время будет теряться

### Формат записи в PROGRESS.md:
```markdown
## Session: YYYY-MM-DD

### ✅ Completed
- [Что сделано] — краткое описание

### 🔄 In Progress
- [Над чем работаю]

### 🐛 Known Issues
- [Проблемы которые нашёл]
```

**Запомни: Документация — это твоя память между сессиями.**

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

---

## Project Overview

Cogitator is a self-hosted, production-grade AI agent runtime for TypeScript. It provides orchestration for LLM swarms and autonomous agents.

## Architecture

```
packages/
├── types/     # @cogitator/types - Shared TypeScript interfaces
├── core/      # @cogitator/core - Main runtime (Agent, Tool, Cogitator)
├── cli/       # @cogitator/cli - CLI tool (future)
├── memory/    # @cogitator/memory - Memory adapters (future)
├── workflows/ # @cogitator/workflows - DAG engine (future)
├── swarms/    # @cogitator/swarms - Multi-agent coordination (future)
└── ...
```

## Key Classes

- `Cogitator` - Main runtime, runs agents
- `Agent` - LLM agent with tools and instructions
- `tool()` - Factory for creating type-safe tools
- `ToolRegistry` - Tool management

## LLM Backends

- `OllamaBackend` - Local Ollama models
- `OpenAIBackend` - OpenAI API
- `AnthropicBackend` - Anthropic Claude API

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

## Progress Tracking

**IMPORTANT:** After completing each feature/task:
1. Update [PROGRESS.md](./PROGRESS.md) with what was done
2. Move completed items to ✅ section
3. Update 🔄 In Progress section

## Current Status

See [PROGRESS.md](./PROGRESS.md) for implementation progress.

## Research & Discoveries

**IMPORTANT:** При исследовании API, библиотек, или новых паттернов:
1. Документируй findings в [PROGRESS.md](./PROGRESS.md) → Research Findings
2. Если это влияет на архитектуру — добавь заметку в соответствующую секцию выше

Используй MCP tools для research:
- `mcp__plugin_context7_context7__resolve-library-id` — найти библиотеку
- `mcp__plugin_context7_context7__query-docs` — получить актуальную документацию
