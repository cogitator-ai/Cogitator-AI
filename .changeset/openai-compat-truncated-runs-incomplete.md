---
'@cogitator-ai/openai-compat': patch
---

A run whose answer stopped at the output token limit (`max_completion_tokens`, or the model's own) now ends `incomplete` with `incomplete_details.reason: 'max_completion_tokens'`, as the OpenAI API reports it, instead of `completed`. The answer is kept as a message with `status: 'incomplete'` and `incomplete_details.reason: 'max_tokens'`, and a stream sends `thread.message.incomplete` and `thread.run.incomplete`, so a client no longer takes a cut-off answer (half a JSON object, for instance) for a finished one. An answer the provider's content filter withheld is an `incomplete` message with reason `content_filter`.
