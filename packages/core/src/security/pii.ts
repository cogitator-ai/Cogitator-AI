import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ContentPart,
  LLMBackend,
  LLMProvider,
  Message,
  PiiConfig,
  PiiFinding,
  PiiType,
  ToolCall,
} from '@cogitator-ai/types';

interface Detector {
  type: string;
  pattern: RegExp;
  valid?: (match: string) => boolean;
}

const BUILT_IN: Record<PiiType, Detector> = {
  email: {
    type: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  },
  credit_card: {
    type: 'credit_card',
    pattern: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
    valid: (match) => luhn(match.replace(/\D/g, '')),
  },
  iban: {
    type: 'iban',
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g,
    valid: (match) => ibanChecksum(match.replace(/ /g, '')),
  },
  ssn: { type: 'ssn', pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  phone: {
    type: 'phone',
    pattern: /(?<![\w+])(?:\+\d[\d\s().-]{7,}\d|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?!\w)/g,
    valid: (match) => {
      const digits = match.replace(/\D/g, '').length;
      return digits >= 10 && digits <= 15;
    },
  },
  ip_address: {
    type: 'ip_address',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
  api_key: {
    type: 'api_key',
    pattern:
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g,
  },
};

export const PII_TYPES = Object.keys(BUILT_IN) as PiiType[];

/**
 * Finds personal data and secrets in text and stands placeholders in for
 * them (`[EMAIL_1]`), remembering each value so it can be put back.
 */
export class PiiMasker {
  private readonly detectors: Detector[];

  constructor(config: Pick<PiiConfig, 'detect' | 'custom'> = {}) {
    const builtIn = (config.detect ?? PII_TYPES).map((type) => BUILT_IN[type]);
    const custom = (config.custom ?? []).map(({ type, pattern }) => ({
      type,
      pattern: new RegExp(
        pattern.source,
        pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
      ),
    }));
    this.detectors = [...custom, ...builtIn];
  }

  /** Every match, longest first where matches overlap. */
  find(text: string): PiiFinding[] {
    const found: Array<PiiFinding & { start: number; end: number }> = [];
    for (const detector of this.detectors) {
      for (const match of text.matchAll(detector.pattern)) {
        const value = match[0];
        const start = match.index;
        if (detector.valid && !detector.valid(value)) continue;
        found.push({ type: detector.type, value, start, end: start + value.length });
      }
    }
    found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
    const kept: typeof found = [];
    for (const finding of found) {
      const last = kept.at(-1);
      if (last && finding.start < last.end) continue;
      kept.push(finding);
    }
    return kept.map(({ type, value }) => ({ type, value }));
  }

  /** `text` with every finding replaced by its placeholder in `vault`. */
  mask(text: string, vault: PiiVault): string {
    let masked = text;
    for (const { type, value } of this.find(text)) {
      masked = masked.split(value).join(vault.placeholderFor(type, value));
    }
    return masked;
  }
}

/** The placeholders of one request: the same value always gets the same one. */
export class PiiVault {
  private readonly byValue = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  readonly findings: PiiFinding[] = [];

  placeholderFor(type: string, value: string): string {
    const existing = this.byValue.get(value);
    if (existing) return existing;
    const label = type.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const index = (this.counts.get(label) ?? 0) + 1;
    this.counts.set(label, index);
    const placeholder = `[${label}_${index}]`;
    this.byValue.set(value, placeholder);
    this.byPlaceholder.set(placeholder, value);
    this.findings.push({ type, value });
    return placeholder;
  }

  get size(): number {
    return this.byValue.size;
  }

  restore(text: string): string {
    if (this.byPlaceholder.size === 0) return text;
    return text.replace(
      /\[[A-Z0-9_]+_\d+\]/g,
      (placeholder) => this.byPlaceholder.get(placeholder) ?? placeholder
    );
  }

  restoreValue(value: unknown): unknown {
    if (typeof value === 'string') return this.restore(value);
    if (Array.isArray(value)) return value.map((item) => this.restoreValue(item));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.restoreValue(item)])
      );
    }
    return value;
  }
}

/**
 * An LLM backend that masks personal data in every request, so the provider
 * never sees it, and — in `mask` mode — puts the real values back into the
 * answer, its stream and the tool calls it makes.
 */
export class PiiMaskingBackend implements LLMBackend {
  readonly provider: LLMProvider;
  private readonly masker: PiiMasker;

  constructor(
    readonly inner: LLMBackend,
    private readonly config: PiiConfig
  ) {
    this.provider = inner.provider;
    this.masker = new PiiMasker(config);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { masked, vault } = this.maskRequest(request);
    const response = await this.inner.chat(masked);
    if (!this.restores) return response;
    return {
      ...response,
      content: vault.restore(response.content),
      ...(response.reasoning && { reasoning: vault.restore(response.reasoning) }),
      ...(response.toolCalls && {
        toolCalls: response.toolCalls.map((call) => restoreCall(call, vault)),
      }),
    };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const { masked, vault } = this.maskRequest(request);
    if (!this.restores || vault.size === 0) {
      yield* this.inner.chatStream(masked);
      return;
    }
    const content = new StreamRestorer(vault);
    const reasoning = new StreamRestorer(vault);
    for await (const chunk of this.inner.chatStream(masked)) {
      const text =
        chunk.delta.content === undefined ? undefined : content.push(chunk.delta.content);
      const thought =
        chunk.delta.reasoning === undefined ? undefined : reasoning.push(chunk.delta.reasoning);
      const final = chunk.finishReason !== undefined;
      const tail = final ? content.flush() : '';
      const thoughtTail = final ? reasoning.flush() : '';
      yield {
        ...chunk,
        delta: {
          ...chunk.delta,
          ...((text !== undefined || tail) && { content: `${text ?? ''}${tail}` }),
          ...((thought !== undefined || thoughtTail) && {
            reasoning: `${thought ?? ''}${thoughtTail}`,
          }),
          ...(chunk.delta.toolCalls && {
            toolCalls: chunk.delta.toolCalls.map((call) =>
              call.arguments
                ? {
                    ...call,
                    arguments: vault.restoreValue(call.arguments) as ToolCall['arguments'],
                  }
                : call
            ),
          }),
        },
      };
    }
  }

  private get restores(): boolean {
    return (this.config.mode ?? 'mask') === 'mask';
  }

  private maskRequest(request: ChatRequest): { masked: ChatRequest; vault: PiiVault } {
    const vault = new PiiVault();
    const messages = request.messages.map((message) => maskMessage(message, this.masker, vault));
    if (vault.findings.length > 0) this.config.onDetect?.(summarize(vault.findings));
    return { masked: { ...request, messages }, vault };
  }
}

/** `backend` behind PII masking per `config`, or `backend` itself without it. */
export function withPiiMasking(backend: LLMBackend, config: PiiConfig | undefined): LLMBackend {
  if (!config || config.mode === 'block') return backend;
  return new PiiMaskingBackend(backend, config);
}

/** Counts per type, for audit logs that must not hold the values themselves. */
function summarize(findings: readonly PiiFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { type } of findings) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

function maskMessage(message: Message, masker: PiiMasker, vault: PiiVault): Message {
  const content =
    typeof message.content === 'string'
      ? masker.mask(message.content, vault)
      : message.content.map((part): ContentPart =>
          part.type === 'text' ? { ...part, text: masker.mask(part.text, vault) } : part
        );
  const toolCalls = (message as Message & { toolCalls?: ToolCall[] }).toolCalls;
  return {
    ...message,
    content,
    ...(toolCalls && {
      toolCalls: toolCalls.map((call) => ({
        ...call,
        arguments: maskValue(call.arguments, masker, vault) as ToolCall['arguments'],
      })),
    }),
  } as Message;
}

function maskValue(value: unknown, masker: PiiMasker, vault: PiiVault): unknown {
  if (typeof value === 'string') return masker.mask(value, vault);
  if (Array.isArray(value)) return value.map((item) => maskValue(item, masker, vault));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskValue(item, masker, vault)])
    );
  }
  return value;
}

function restoreCall(call: ToolCall, vault: PiiVault): ToolCall {
  return { ...call, arguments: vault.restoreValue(call.arguments) as ToolCall['arguments'] };
}

/**
 * Restores placeholders in streamed text, holding back a trailing `[...`
 * that could be the start of a placeholder until the next piece completes it.
 */
class StreamRestorer {
  private pending = '';

  constructor(private readonly vault: PiiVault) {}

  push(text: string): string {
    const combined = this.pending + text;
    const open = combined.lastIndexOf('[');
    const holdBack = open !== -1 && !combined.includes(']', open) && combined.length - open <= 40;
    this.pending = holdBack ? combined.slice(open) : '';
    return this.vault.restore(holdBack ? combined.slice(0, open) : combined);
  }

  flush(): string {
    const rest = this.vault.restore(this.pending);
    this.pending = '';
    return rest;
  }
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function ibanChecksum(iban: string): boolean {
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}
