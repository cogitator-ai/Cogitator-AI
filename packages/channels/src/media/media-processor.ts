import type { Attachment, ImageInput } from '@cogitator-ai/types';
import type { LocalWhisper } from './whisper-local';

export interface SttProvider {
  transcribe(buffer: Buffer, mimeType: string): Promise<string>;
}

export interface MediaProcessResult {
  images: ImageInput[];
  transcribedText: string | null;
  systemNotes: string[];
}

export class MediaProcessor {
  constructor(
    private whisper: LocalWhisper | null,
    private checkVision: (modelId: string) => boolean,
    private sttProvider?: SttProvider | null
  ) {}

  async process(attachments: Attachment[], modelId: string): Promise<MediaProcessResult> {
    const images: ImageInput[] = [];
    let transcribedText: string | null = null;
    const systemNotes: string[] = [];

    const imageAttachments = attachments.filter((a) => a.type === 'image');
    const audioAttachments = attachments.filter((a) => a.type === 'audio');

    if (imageAttachments.length > 0) {
      const hasVision = this.checkVision(modelId);
      if (hasVision) {
        for (const att of imageAttachments) {
          if (att.buffer) {
            const mimeType = this.normalizeImageMime(att.mimeType);
            images.push({
              data: att.buffer.toString('base64'),
              mimeType,
            });
          } else if (att.url) {
            images.push(att.url);
          }
        }
      } else {
        systemNotes.push(
          '[System: the user sent an image but your model does not support image recognition. Let them know politely.]'
        );
      }
    }

    if (audioAttachments.length > 0) {
      const firstAudio = audioAttachments[0];
      if (firstAudio.buffer) {
        transcribedText = await this.transcribeAudio(
          firstAudio.buffer,
          firstAudio.mimeType,
          systemNotes
        );
      }
    }

    return { images, transcribedText, systemNotes };
  }

  private async transcribeAudio(
    buffer: Buffer,
    mimeType: string,
    systemNotes: string[]
  ): Promise<string | null> {
    if (this.sttProvider) {
      try {
        return await this.sttProvider.transcribe(buffer, mimeType);
      } catch (err) {
        console.error('[media] STT provider failed:', (err as Error).message);
        systemNotes.push(
          '[System: the user sent a voice message but transcription failed due to a technical error.]'
        );
        return null;
      }
    }

    if (this.whisper?.isModelDownloaded()) {
      try {
        return await this.whisper.transcribe(buffer, mimeType);
      } catch (err) {
        console.error('[media] Whisper transcription failed:', (err as Error).message);
        systemNotes.push(
          '[System: the user sent a voice message but transcription failed due to a technical error.]'
        );
        return null;
      }
    }

    systemNotes.push(
      '[System: the user sent a voice message but speech recognition is not set up yet. ' +
        'Suggest downloading it using the download_stt_model tool (~75MB, works offline). ' +
        'Ask the user for confirmation first.]'
    );
    return null;
  }

  private normalizeImageMime(
    mime: string
  ): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
    if (mime === 'image/png') return 'image/png';
    if (mime === 'image/gif') return 'image/gif';
    if (mime === 'image/webp') return 'image/webp';
    return 'image/jpeg';
  }
}
