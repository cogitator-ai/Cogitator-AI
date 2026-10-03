---
'@cogitator-ai/voice': minor
---

Add `ttsOptions` to `VoicePipelineConfig` and `VoiceAgentConfig`. The pipeline called `synthesize`/`streamSynthesize` without options, so formats such as raw `pcm16` audio, or a per-pipeline voice, speed or instructions, could not be requested; the options are now passed to every TTS call.
