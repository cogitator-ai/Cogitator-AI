import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import type { Tool } from '@cogitator-ai/types';
import type { LocalWhisper } from './whisper-local';

export function createWhisperDownloadTool(whisper: LocalWhisper): Tool {
  return tool({
    name: 'download_stt_model',
    description:
      'Download speech recognition model (~75MB) for offline voice message transcription. ' +
      'Call this when the user confirms they want voice message support. ' +
      'Downloads once, works offline after that.',
    parameters: z.object({}),
    execute: async () => {
      if (whisper.isModelDownloaded()) {
        return { success: true, message: 'Model already downloaded' };
      }
      await whisper.download();
      return { success: true, message: 'Whisper model downloaded', modelDir: whisper.modelDir };
    },
  });
}
