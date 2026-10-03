---
'@cogitator-ai/channels': patch
---

The WhatsApp channel supports Baileys 7 (`@whiskeysockets/baileys` 7.x, now its `latest`) next to 6.x. When WhatsApp addresses a person by LID, the message's `userId` is still their phone number from `remoteJidAlt` / `participantAlt` whenever WhatsApp shares it, so owner lists and per-user memory keep matching.
