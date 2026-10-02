import type { Attachment, ImageInput } from '@cogitator-ai/types';
import type { LocalWhisper } from './whisper-local';
import { baseMimeType } from './audio-format';

export interface SttProvider {
  transcribe(buffer: Buffer, mimeType: string): Promise<string>;
}

export interface MediaProcessResult {
  images: ImageInput[];
  transcribedText: string | null;
  systemNotes: string[];
}

export interface MediaProcessorOptions {
  /** Maximum number of characters inlined from a text file attachment. Default: 20000. */
  maxInlineTextChars?: number;
  /** Maximum attachment size fetched from a URL, in bytes. Default: 25 MiB. */
  maxDownloadBytes?: number;
}

type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const TEXT_MIME_RE =
  /^(text\/|application\/(json|xml|yaml|x-yaml|toml|javascript|typescript|x-sh|csv|sql|markdown))/;
const TEXT_EXT_RE =
  /\.(txt|md|markdown|json|ya?ml|toml|csv|tsv|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sh|sql|log|ini|env)$/i;

function attachmentLabel(att: Attachment): string {
  return att.filename ? `"${att.filename}" (${att.mimeType})` : att.mimeType;
}

export class MediaProcessor {
  private readonly maxInlineTextChars: number;
  private readonly maxDownloadBytes: number;

  constructor(
    private whisper: LocalWhisper | null,
    private checkVision: (modelId: string) => boolean,
    private sttProvider?: SttProvider | null,
    options: MediaProcessorOptions = {}
  ) {
    this.maxInlineTextChars = options.maxInlineTextChars ?? 20_000;
    this.maxDownloadBytes = options.maxDownloadBytes ?? 25 * 1024 * 1024;
  }

  async process(attachments: Attachment[], modelId: string): Promise<MediaProcessResult> {
    const images: ImageInput[] = [];
    const transcripts: string[] = [];
    const systemNotes: string[] = [];

    const imageAttachments = attachments.filter((a) => a.type === 'image');
    if (imageAttachments.length > 0) {
      if (this.checkVision(modelId)) {
        for (const att of imageAttachments) {
          if (att.buffer) {
            images.push({
              data: Buffer.from(att.buffer).toString('base64'),
              mimeType: this.normalizeImageMime(att.mimeType),
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

    for (const att of attachments.filter((a) => a.type === 'audio')) {
      const buffer = await this.loadBuffer(att, systemNotes);
      if (!buffer) continue;
      const text = await this.transcribeAudio(buffer, baseMimeType(att.mimeType), systemNotes);
      if (text) transcripts.push(text);
    }

    for (const att of attachments.filter((a) => a.type === 'video')) {
      systemNotes.push(
        `[System: the user sent a video ${attachmentLabel(att)}. Video content cannot be analyzed directly.]`
      );
    }

    for (const att of attachments.filter((a) => a.type === 'file')) {
      await this.processFile(att, systemNotes);
    }

    return {
      images,
      transcribedText: transcripts.length > 0 ? transcripts.join('\n') : null,
      systemNotes,
    };
  }

  private isTextFile(att: Attachment): boolean {
    const mime = baseMimeType(att.mimeType);
    return TEXT_MIME_RE.test(mime) || (!!att.filename && TEXT_EXT_RE.test(att.filename));
  }

  private async processFile(att: Attachment, systemNotes: string[]): Promise<void> {
    if (!this.isTextFile(att)) {
      systemNotes.push(
        `[System: the user attached a file ${attachmentLabel(att)} that cannot be read directly.]`
      );
      return;
    }

    const buffer = await this.loadBuffer(att, systemNotes);
    if (!buffer) return;

    const content = buffer.toString('utf-8');
    const truncated = content.length > this.maxInlineTextChars;
    const body = truncated ? content.slice(0, this.maxInlineTextChars) : content;
    systemNotes.push(
      `[System: the user attached a file ${attachmentLabel(att)}${truncated ? ', truncated' : ''}. Contents:]\n${body}`
    );
  }

  private async loadBuffer(att: Attachment, systemNotes: string[]): Promise<Buffer | null> {
    if (att.buffer) return Buffer.from(att.buffer);
    if (!att.url) return null;

    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > this.maxDownloadBytes) {
        throw new Error(`attachment exceeds ${this.maxDownloadBytes} bytes`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength > this.maxDownloadBytes) {
        throw new Error(`attachment exceeds ${this.maxDownloadBytes} bytes`);
      }
      return buffer;
    } catch (err) {
      systemNotes.push(
        `[System: the user sent ${attachmentLabel(att)} but it could not be downloaded: ${(err as Error).message}.]`
      );
      return null;
    }
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

  private normalizeImageMime(mime: string): ImageMime {
    const base = baseMimeType(mime);
    if (base === 'image/png' || base === 'image/gif' || base === 'image/webp') return base;
    return 'image/jpeg';
  }
}
