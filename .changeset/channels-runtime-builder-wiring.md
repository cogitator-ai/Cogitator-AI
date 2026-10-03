---
'@cogitator-ai/channels': minor
---

`RuntimeBuilder` now wires what the gateway supports: `channels.whatsapp` and `channels.webchat` in the assistant config (WebChat requires `WEBCHAT_TOKEN`), an `approvals` config block, and `hooks` / `approvals` builder options passed to the gateway. Previously only Telegram, Discord and Slack could be configured and hooks or approval settings never reached the gateway.
