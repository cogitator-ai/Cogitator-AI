# Product Improvements Design

**Date:** 2026-02-20
**Status:** In Progress

## Phase 1 — New Packages (Priority)

### 1. @cogitator-ai/evals — Evaluation Framework

Systematic agent quality assessment. Without this, there's no way to know if changes improve or degrade agent performance.

**Components:**

- **Datasets** — load test cases from JSONL, CSV, or programmatically. Each case: `{ input, expected?, metadata? }`
- **Metrics:**
  - Deterministic: exact match, contains, regex, JSON schema validation
  - LLM-as-judge: faithfulness, relevance, coherence, helpfulness
  - Statistical: latency p50/p95/p99, cost per run, token usage
  - Custom metric functions
- **Eval Runner:**
  - Run agent against dataset with concurrency control
  - Progress reporting, result aggregation
  - Retry on flaky cases
- **Assertions:**
  - Threshold-based: `accuracy > 0.9`
  - Comparison: model A vs model B
  - Regression detection: compare to baseline
- **Reporters:**
  - Console (pretty table)
  - JSON/CSV export
  - CI integration (exit code based on assertions)
- **A/B Testing:**
  - Compare prompts, models, temperatures
  - Statistical significance

**API:**
```ts
const suite = new EvalSuite({
  dataset: Dataset.fromJsonl('./tests/qa.jsonl'),
  agent: myAgent,
  metrics: [exactMatch(), faithfulness(), latency()],
  assertions: [threshold('accuracy', 0.9)],
  concurrency: 5,
})

const results = await suite.run()
results.report('console')
```

**Tests:** Unit tests for each metric/assertion + e2e with real LLM evaluating agent quality.

---

### 2. @cogitator-ai/rag — RAG Pipeline ✅ DONE

Most common AI agent use case. Must be first-class, not "assemble from pieces yourself".

**Components:**

- **Document Loaders:** PDF (pdf-parse), HTML (cheerio), CSV (papaparse), Markdown, JSON, plain text, web URL
  - Unified `Loader` interface for custom loaders
- **Chunking Strategies:**
  - Fixed size (with overlap)
  - Recursive (split by headings -> paragraphs -> sentences)
  - Semantic (embedding-based — cut where meaning changes)
  - Custom chunker interface
- **Storage:** Uses existing memory adapters (Qdrant, pgvector, SQLite, in-memory) — RAG package only orchestrates
- **Retrieval:**
  - Similarity search (cosine, dot product)
  - MMR (Maximal Marginal Relevance)
  - Hybrid (BM25 + vector — already exists in memory)
  - Multi-query (LLM generates multiple queries, merges results)
- **Reranking:**
  - Cohere Rerank API
  - LLM-based reranking (any backend)
  - Custom reranker interface
- **Agent Integration:** RAG pipeline exports itself as tools — agent decides when to search

**API:**
```ts
const rag = new RAGPipeline({
  loader: pdfLoader(),
  chunker: recursiveChunker({ maxSize: 512, overlap: 50 }),
  embedder: openaiEmbedder(),
  store: qdrantStore({ collection: 'docs' }),
  retriever: hybridRetriever({ topK: 10 }),
  reranker: cohereReranker({ topN: 5 }),
})

await rag.ingest('./documents/')
const context = await rag.query('How does authentication work?')

const agent = new Agent({
  tools: [rag.asSearchTool(), rag.asIngestTool()],
})
```

**Tests:** Unit tests for loaders/chunkers/retrieval + e2e ingest-query pipeline with real embeddings.

---

### 3. @cogitator-ai/voice — Voice/Realtime Agents

Voice agents are the hottest trend. Phone bots, assistants, customer service.

**Components:**

- **STT Providers:** OpenAI Whisper, Deepgram (real-time streaming), Google Cloud STT
  - Unified `STTProvider` interface
- **TTS Providers:** OpenAI TTS, ElevenLabs, Google Cloud TTS
  - Unified `TTSProvider` interface
- **VAD (Voice Activity Detection):** Silero VAD (WASM), energy-based fallback
- **Transport:** WebSocket (primary), WebRTC (low latency), HTTP streaming (batch)
- **Realtime API Integration:** OpenAI Realtime API adapter, Gemini Live API adapter
- **Phone:** Twilio integration (inbound/outbound), webhook handlers for all server adapters
- **Pipeline Features:**
  - Interruption handling
  - Turn management
  - Silence detection
  - Streaming TTS (starts speaking while still generating)

**API:**
```ts
const voiceAgent = new VoiceAgent({
  agent: myAgent,
  stt: deepgramSTT({ model: 'nova-2' }),
  tts: elevenLabsTTS({ voice: 'rachel' }),
  vad: sileroVAD(),
  transport: websocketTransport({ port: 8080 }),
})

voiceAgent.on('turn:start', (turn) => { ... })
voiceAgent.on('interrupted', () => { ... })
await voiceAgent.listen()

// Twilio
app.post('/twilio/voice', voiceAgent.twilioWebhook())
```

**Tests:** Unit tests for each provider + integration tests with real STT/TTS APIs.

---

### 4. @cogitator-ai/browser — Browser Automation Tools

Agents that interact with websites — scraping, form filling, data extraction.

**Components:**

- **Browser Management:** Playwright-based, browser pool, headless/headed, proxy, persistent contexts
- **Tools:**
  - `navigate(url)`, `click(selector)`, `type(selector, text)`
  - `screenshot()` (base64 for vision LLM), `extractText(selector?)`, `extractHtml(selector?)`
  - `waitFor(selector)`, `evaluate(js)`, `scroll(direction)`
  - `select(selector, value)`, `getAttribute(selector, attr)`, `getLinks()`, `fillForm(fields)`
- **Two modes:** Selector-based (fast, precise) and Vision-based (screenshot -> vision LLM -> coordinates)
- **Session Management:** Persistent sessions (cookies, auth), proxy support

**API:**
```ts
const session = new BrowserSession({ headless: true })
const agent = new Agent({
  tools: browserTools(session),
  instructions: 'Navigate to the website and extract pricing data',
})
const result = await cogitator.run(agent, 'Go to example.com and get all prices')
await session.close()
```

**Tests:** Unit tests + e2e with real browser (Playwright in headless mode).

---

## Phase 2 — DX Improvements (Next Priority)

### 5. Documentation Site Updates
- Docs already exist at `packages/dashboard/content/docs/` using Fumadocs
- Add new sections for evals, rag, voice, browser packages
- Keep in sync with package README files

### 6. Agent Playground
- Web UI in dashboard: assemble agent, connect tools, chat, view trace live
- Already have `packages/dashboard/src/app/dashboard/playground/`

### 7. Structured Data Extraction
- First-class pipeline: PDF/HTML/email -> structured JSON via Zod schema
- With validation and retry on parse errors

---

## Phase 3 — Ambitious Features

### 8. Visual Workflow Editor
- Drag-and-drop DAG editor (React Flow — already a dependency in dashboard)
- Export to code, n8n-style
- Already have workflow components in dashboard

### 9. VS Code Extension
- Tool definition autocomplete, inline trace viewer, run agents from editor

### 10. Extended Guardrails
- PII detection, topic filtering, per-user rate limiting, audit logging

---

## Phase 4 — Future Vision

### 11. Agent Marketplace
- Registry for sharing tools, agents, workflows between projects

### 12. Multi-modal Pipeline
- Native image, audio, video processing in agent pipeline

### 13. Distributed Agents
- Agent mesh — agents on different servers coordinating via message queue

---

## Per-Package Deliverables Checklist

For each new package in Phase 1:
- [ ] Package scaffolding (package.json, tsconfig, src/)
- [ ] Types in @cogitator-ai/types
- [ ] Core implementation
- [ ] Unit tests (vitest)
- [ ] E2e tests with real LLM/APIs
- [ ] README.md with full API docs
- [ ] Examples in examples/
- [ ] Fumadocs pages in dashboard/content/docs/
- [ ] Export from main package
- [ ] Publish via scripts/publish-all.ts

### Completion Status

| Package | Status | Date | Notes |
|---------|--------|------|-------|
| @cogitator-ai/evals | Pending | — | — |
| @cogitator-ai/rag | **Done** | 2026-02-20 | 136 unit tests, 3 examples, 6 Fumadocs pages, published v0.1.0 |
| @cogitator-ai/voice | Pending | — | — |
| @cogitator-ai/browser | Pending | — | — |
