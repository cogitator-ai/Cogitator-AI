---
'@cogitator-ai/openai-compat': minor
---

Server failures no longer reach API clients with their text: the error handler answers every 5xx with `Internal server error`, a failed run's `last_error` says `Internal server error` unless the cause is a `CogitatorError` or a refused request, and storage failures while creating, cancelling or resuming a run answer 500 instead of 400. Refused requests throw the new exported `InvalidRequestError` and answer 400 with their `param`. `GET /v1/files` honours `limit` (up to 10 000, all files by default), `order` and `after`. `max_prompt_tokens` is applied: the oldest thread messages are left out of the prompt until it fits, and a run whose last message alone does not fit ends `incomplete` with `incomplete_details.reason: 'max_prompt_tokens'`.
