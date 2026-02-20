# @cogitator-ai/core

## 0.18.0

### Minor Changes

- Add Ollama Cloud support with API key authentication
  - `apiKey` field in `OllamaProviderConfig` for cloud authentication
  - `OLLAMA_API_KEY` env variable auto-detection with default base URL `https://ollama.com`
  - `Authorization: Bearer` header in OllamaBackend when API key is configured

### Patch Changes

- Fix ESM directory import conflicts, streaming content handling, and integration test stability
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/memory@0.6.13
  - @cogitator-ai/models@17.1.4
  - @cogitator-ai/sandbox@0.2.23

## 0.17.4

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2
  - @cogitator-ai/memory@0.6.11
  - @cogitator-ai/models@17.1.2
  - @cogitator-ai/sandbox@0.2.21

## 0.17.3

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1
  - @cogitator-ai/memory@0.6.10
  - @cogitator-ai/models@17.1.1
  - @cogitator-ai/sandbox@0.2.20

## 0.17.2

### Patch Changes

- Update model registry to January 2026 models
  - Add Claude Opus 4.5, Sonnet 4.5, Haiku 4.5
  - Add GPT-4.1, GPT-4.1 Mini/Nano, o3, o4-mini
  - Add Gemini 3 Pro/Flash Preview, Gemini 2.5 Pro/Flash/Flash-Lite
  - Mark deprecated models (Claude 3.x, GPT-4 Turbo, Gemini 1.5/2.0)
  - Fix model selector and cost estimator for new models
  - Export all 26 built-in tools from @cogitator-ai/core

- Updated dependencies
  - @cogitator-ai/models@17.1.0

## 0.17.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0
  - @cogitator-ai/memory@0.6.9
  - @cogitator-ai/models@17.0.0
  - @cogitator-ai/sandbox@0.2.19

## 0.17.0

### Minor Changes

- Add long-context optimization with automatic compression strategies

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0
  - @cogitator-ai/memory@0.6.8
  - @cogitator-ai/models@16.0.0
  - @cogitator-ai/sandbox@0.2.18

## 0.16.0

### Minor Changes

- feat: add audio/speech support with Whisper and TTS

  Audio Transcription (Whisper API):
  - `createTranscribeAudioTool` factory for speech-to-text
  - Support for whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe models
  - Word-level timestamps with verbose_json response format
  - URL and base64 audio input support

  Text-to-Speech (TTS API):
  - `createGenerateSpeechTool` factory for TTS generation
  - Support for tts-1, tts-1-hd, gpt-4o-mini-tts models
  - 13 voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar
  - Output formats: mp3, opus, aac, flac, wav, pcm
  - Speed control: 0.25x to 4.0x

  Integration:
  - `AudioInput` and `AudioFormat` types
  - `audio` option in `cog.run()` for automatic transcription
  - `fetchAudioAsBuffer` and `audioInputToBuffer` helpers

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0
  - @cogitator-ai/memory@0.6.7
  - @cogitator-ai/models@15.0.0
  - @cogitator-ai/sandbox@0.2.17

## 0.15.0

### Minor Changes

- 6b09d54: feat(core): implement Agent serialization and deserialization

  Add serialize() and Agent.deserialize() methods for agent persistence:
  - AgentSnapshot format with version field for backward compatibility
  - Tool names stored instead of full tool objects (functions are not serializable)
  - Tool resolution via ToolRegistry or direct array on deserialize
  - Config overrides support during restoration
  - Agent.validateSnapshot() for runtime type checking
  - AgentDeserializationError for clear error messages

  This enables:
  - Pause/resume agents across process restarts
  - Sharing agent configurations as JSON
  - Storing agents in databases

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0
  - @cogitator-ai/memory@0.6.6
  - @cogitator-ai/models@14.0.0
  - @cogitator-ai/sandbox@0.2.16

## 0.14.0

### Minor Changes

- feat(cost-routing): implement cost prediction before agent execution

  Add `estimateCost()` method to Cogitator that estimates the cost of running an agent BEFORE execution.

  New components:
  - `TokenEstimator`: Heuristic-based token estimation
  - `CostEstimator`: Combines task analysis, model pricing, and token estimation

  Features:
  - Complexity-based output token estimates (simple/moderate/complex)
  - Iteration and tool call estimation based on task requirements
  - Confidence scores (lower for complex tasks with many tools)
  - Local model detection (Ollama models return $0 cost)
  - Warnings for unpredictable costs, missing pricing data

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0
  - @cogitator-ai/memory@0.6.5
  - @cogitator-ai/models@13.0.0
  - @cogitator-ai/sandbox@0.2.15

## 0.13.0

### Minor Changes

- feat(security): implement prompt injection detection

  Add PromptInjectionDetector to protect agents from adversarial inputs:
  - Local classifier: fast regex + heuristics (<5ms latency)
  - LLM classifier: semantic analysis for complex attacks
  - 30+ built-in patterns for 5 threat types (direct injection, jailbreak, roleplay, context manipulation, encoding)
  - Allowlist support for false positive prevention
  - Custom pattern support with runtime add/remove
  - Integration with Cogitator via security.promptInjection config

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0
  - @cogitator-ai/memory@0.6.4
  - @cogitator-ai/models@12.0.0
  - @cogitator-ai/sandbox@0.2.14

## 0.12.0

### Minor Changes

- feat(core): implement tool caching layer with semantic matching
  - Add withCache() wrapper for caching tool execution results
  - Support exact match (SHA256 hash) and semantic (embedding similarity) caching
  - InMemoryToolCacheStorage with LRU eviction
  - RedisToolCacheStorage with TTL and sorted sets
  - Cache stats, invalidation, warmup, and callbacks

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0
  - @cogitator-ai/memory@0.6.3
  - @cogitator-ai/models@11.0.0
  - @cogitator-ai/sandbox@0.2.13

## 0.11.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/memory@0.6.2

## 0.11.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0
  - @cogitator-ai/memory@0.6.1
  - @cogitator-ai/models@10.0.0
  - @cogitator-ai/sandbox@0.2.12

## 0.11.3

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0
  - @cogitator-ai/memory@0.6.0
  - @cogitator-ai/models@9.0.0
  - @cogitator-ai/sandbox@0.2.11

## 0.11.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1
  - @cogitator-ai/memory@0.5.2
  - @cogitator-ai/models@8.0.1
  - @cogitator-ai/sandbox@0.2.10

## 0.11.1

### Patch Changes

- Updated dependencies [abdafa3]
  - @cogitator-ai/sandbox@0.2.9

## 0.11.0

### Minor Changes

- DX Improvements - Phases 1-3

  Phase 1: Foundation
  - Added comprehensive JSDoc documentation to core public APIs
  - Extended config schema with memory, sandbox, reflection, guardrails, costRouting, logging

  Phase 2: Critical Fixes
  - ThreadManager: Added persistent storage with InMemoryThreadStorage, RedisThreadStorage, PostgresThreadStorage
  - SSE Streaming: EventEmitter-based real-time streaming for openai-compat
  - MCP Retry: Exponential backoff with auto-reconnect and connection recovery

  Phase 3: Polish
  - New examples: memory-persistence, openai-compat-server, mcp-integration, constitutional-guardrails

## 0.10.0

### Minor Changes

- 58a7271: Phase 6: DX Improvements
  - Add structured LLM errors with rich context (provider, model, endpoint, statusCode, retryable, retryAfter)
  - Add debug mode wrapper with request/response logging
  - Add type-safe provider configurations with discriminated unions
  - Add plugin system for registering custom LLM backends

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/types@0.10.0
  - @cogitator-ai/memory@0.5.1
  - @cogitator-ai/models@8.0.0
  - @cogitator-ai/sandbox@0.2.8

## 0.9.0

### Minor Changes

- Phase 5: Memory adapters and observability integrations

  Memory Adapters:
  - SQLite adapter with WAL mode for zero-config local development
  - MongoDB adapter for flexible document storage
  - Qdrant vector adapter for semantic similarity search

  Observability:
  - Langfuse exporter for LLM-native observability
  - OpenTelemetry OTLP exporter for universal tracing

  All adapters use dynamic imports - install only what you need.

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0
  - @cogitator-ai/memory@0.5.0
  - @cogitator-ai/models@7.0.0
  - @cogitator-ai/sandbox@0.2.7

## 0.8.0

### Minor Changes

- faed1e7: feat(core): add 6 new built-in tools

  New tools for web, database, and productivity:
  - `webSearch` - Search the web via Tavily, Brave, or Serper APIs
  - `webScrape` - Extract content from web pages (text/markdown/html output, CSS selectors)
  - `sqlQuery` - Execute SQL queries against PostgreSQL or SQLite
  - `vectorSearch` - Semantic search with embeddings (OpenAI/Ollama/Google + pgvector)
  - `sendEmail` - Send emails via Resend API or SMTP
  - `githubApi` - GitHub API integration (issues, PRs, files, commits, search)

  All tools support auto-detection of providers from environment variables and use dynamic imports for optional dependencies.

  Also adds new tool categories (`web`, `database`, `communication`, `development`) and `external` side effect type.

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/types@0.8.1
  - @cogitator-ai/memory@0.4.3
  - @cogitator-ai/models@6.0.1
  - @cogitator-ai/sandbox@0.2.6

## 0.7.0

### Minor Changes

- 70679b8: feat(core): add Azure OpenAI and AWS Bedrock backends

  Enterprise LLM providers for production deployments:

  **Azure OpenAI:**
  - Full chat and streaming support via official OpenAI SDK
  - Configurable deployment, endpoint, and API version
  - Tool calling, structured outputs, vision

  **AWS Bedrock:**
  - Uses Converse API for unified chat interface
  - Dynamic SDK import (optional peer dependency)
  - Supports Claude, Llama, Mistral, Cohere, Titan models
  - Tool calling with proper type safety

  Both backends integrate seamlessly with the universal LLM interface.

- 2f599f0: feat: add parallel tool execution and tool choice support

  **Parallel Tool Execution:**
  - New `parallelToolCalls` option in `RunOptions` enables concurrent tool execution
  - When enabled, independent tool calls execute via `Promise.all` for improved performance
  - Default remains sequential execution for deterministic behavior

  **Tool Choice:**
  - New `ToolChoice` type: `'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }`
  - New `toolChoice` field in `ChatRequest` interface
  - Provider-specific implementations:
    - OpenAI: native tool_choice support
    - Anthropic: maps to `tool_choice` with `type: 'auto' | 'any' | 'tool'`
    - Google: uses `functionCallingConfig` with mode and allowedFunctionNames
    - Ollama: filters tools based on choice (workaround for no native API support)

- 10956ae: feat: add structured outputs / JSON mode support

  Implement responseFormat parameter across all LLM backends for guaranteed JSON output:
  - **json_object**: Simple JSON mode - model returns valid JSON
  - **json_schema**: Strict schema validation with name, description, and schema definition

  Works with all backends:
  - OpenAI: Native response_format support
  - Anthropic: Tool-based JSON schema forcing
  - Google: responseMimeType and responseSchema in generationConfig
  - Ollama: format parameter with 'json' or schema object

  ```typescript
  // Simple JSON mode
  const result = await backend.chat({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'List 3 colors as JSON array' }],
    responseFormat: { type: 'json_object' },
  });

  // Strict schema validation
  const result = await backend.chat({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Extract person info' }],
    responseFormat: {
      type: 'json_schema',
      jsonSchema: {
        name: 'person',
        schema: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
          required: ['name', 'age'],
        },
      },
    },
  });
  ```

- 218d91f: feat: add vision / multi-modal support

  Message content now supports images in addition to text:
  - `MessageContent` = `string | ContentPart[]`
  - `ContentPart` can be `text`, `image_url`, or `image_base64`

  All LLM backends updated to handle multi-modal content:
  - **OpenAI**: `image_url` parts with detail level support
  - **Anthropic**: `image` source with URL or base64
  - **Google Gemini**: `inlineData` and `fileData` parts
  - **Ollama**: `images` array with base64 data

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/types@0.8.0
  - @cogitator-ai/memory@0.4.2
  - @cogitator-ai/models@6.0.0
  - @cogitator-ai/sandbox@0.2.5

## 0.6.1

### Patch Changes

- 29ce518: fix(core): preserve full model name when explicit provider is set

## 0.6.0

### Minor Changes

- a7c2b43: feat(core): add explicit provider override in AgentConfig

  Allows specifying provider directly in AgentConfig (e.g., 'openai' for OpenRouter) instead of relying only on model string parsing.

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/types@0.7.0
  - @cogitator-ai/memory@0.4.1
  - @cogitator-ai/models@5.0.0
  - @cogitator-ai/sandbox@0.2.4

## 0.5.0

### Minor Changes

- f874e69: ### Memory improvements
  - Add optional `threadId` parameter to `createThread()` in MemoryAdapter interface for proper thread linking
  - Add Google embedding service using `text-embedding-004` model (768 dimensions)
  - Implement hybrid context strategy (30% semantic + 70% recent messages)
  - Fix foreign key constraint violation when saving entries before thread creation

  ### Swarms improvements
  - Add `saveHistory` option to `SwarmRunOptions` to control memory saving per run
  - Fix negotiation strategy import conflict (renamed file to avoid directory resolution issue)
  - Fix coordinator to properly register pipeline stages and handle missing negotiation section

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/memory@0.4.0
  - @cogitator-ai/types@0.6.0
  - @cogitator-ai/models@4.0.0
  - @cogitator-ai/sandbox@0.2.3

## 0.4.0

### Minor Changes

- feat(causal): add causal reasoning engine

  Implement full causal reasoning framework based on Pearl's Ladder of Causation:

  **Causal Graphs**
  - CausalGraphImpl with Map-based storage
  - CausalGraphBuilder fluent API
  - Node/edge operations (parents, children, ancestors, descendants)
  - Path finding with strength accumulation
  - Cycle detection and Markov blanket computation

  **Inference Engine**
  - D-separation algorithm (Bayes-Ball)
  - Backdoor and frontdoor adjustment criteria
  - Interventional effect computation
  - Average Treatment Effect (ATE) estimation
  - Effect identifiability checking

  **Counterfactual Reasoning**
  - Three-phase algorithm: Abduction → Action → Prediction
  - Structural equation evaluation (linear/logistic)
  - Counterfactual query handling

  **Causal Discovery**
  - LLM-based causal extraction from tool results
  - Hypothesis generation from traces
  - Counterfactual validation via forking
  - Pattern recognition and evidence accumulation

  **Types**
  - CausalNode, CausalEdge, CausalGraph interfaces
  - CausalRelationType: causes, enables, prevents, mediates, confounds, moderates
  - InterventionQuery and CounterfactualQuery types
  - StructuralEquation with linear/logistic/custom support

  **Fixes**
  - self-modifying: Fix test API compatibility issues

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/types@0.5.0
  - @cogitator-ai/memory@0.3.1
  - @cogitator-ai/models@3.0.0
  - @cogitator-ai/sandbox@0.2.2

## 0.3.0

### Minor Changes

- feat: add Knowledge Graph Memory and Prompt Auto-Optimization

  **Knowledge Graph Memory:**
  - PostgresGraphAdapter for entity-relationship storage with pgvector
  - Multi-hop graph traversal with BFS/DFS algorithms
  - Shortest path finding between nodes
  - Semantic node search with embeddings
  - LLMEntityExtractor for extracting entities/relations from text
  - GraphInferenceEngine for rule-based relationship inference
  - GraphContextBuilder for graph-aware context building

  **Prompt Auto-Optimization:**
  - PostgresTraceStore for persistent trace and prompt storage
  - PromptLogger wrapper for capturing all LLM prompts
  - ABTestingFramework with Welch's t-test statistical analysis
  - PromptMonitor for real-time performance monitoring with degradation detection
  - RollbackManager for instruction version control
  - AutoOptimizer for automated optimization pipeline with A/B testing

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0
  - @cogitator-ai/memory@0.3.0
  - @cogitator-ai/models@2.0.0
  - @cogitator-ai/sandbox@0.2.1

## 0.2.0

### Minor Changes

- **Timeout enforcement**: Agent timeout config now properly enforced using AbortController
- **Tool input validation**: Tool arguments validated with Zod before execution
- **Memory error callback**: Added `onMemoryError` callback to `RunOptions` for handling memory failures
- **Tool categories**: Tools now support `category` and `tags` fields for organization

### Improvements

- Abort signal now passed to tool context for graceful cancellation
- Better error messages for invalid tool arguments

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
  - @cogitator-ai/memory@0.1.1
  - @cogitator-ai/models@1.0.0
  - @cogitator-ai/sandbox@0.1.1
