---
'@cogitator-ai/core': patch
---

A streamed run with the Constitutional AI output filter on no longer shows the model's text before the filter checked it. The runtime holds back the tokens of each turn and hands `onToken` the checked text in one chunk: the answer when it passes, the revision when the critique-revise loop rewrote it, and nothing when it is blocked. Every server adapter streams through `onToken`, so SSE, WebSocket, A2A and openai-compat clients never see blocked text that the memory then replaces with a revision.
