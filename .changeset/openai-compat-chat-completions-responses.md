---
'@cogitator-ai/openai-compat': minor
---

The server now speaks the OpenAI APIs current clients use: `POST /v1/chat/completions` and `POST /v1/responses`, streaming and not, with the agent as the `model`. Register agents with the new `agents` option and every OpenAI client (the official SDKs, Open WebUI, LibreChat) talks to them:

- Each request runs the agent with its own instructions, model and tools, the client's system prompt after its instructions, and the request's sampling settings, token limit, stop sequences and response format.
- Functions the client declares come back as tool calls (`finish_reason: 'tool_calls'`, `function_call` items), and the outputs the client sends resume the same run.
- Usage includes cached and reasoning tokens, `finish_reason` and the Responses `incomplete_details` report truncated and filtered answers, and errors use the OpenAI error format (`model_not_found` for an unknown agent).
- Responses streams send the Responses events, responses are kept for `previous_response_id`, `GET /v1/responses/{id}`, its `input_items` and `DELETE`.
- `GET /v1/models` lists the agents, and `GET /v1/models/{id}` returns one. A client that disconnects aborts the run.

New options: `agents`, `maxRequestBodyBytes` (default 20 MB) and `maxStoredResponses` (default 1000). The Assistants API endpoints keep working but are deprecated, since OpenAI sunset that API on 2026-08-26.
