import type { LLMBackend } from './llm';

export type InjectionThreatType =
  'direct_injection' | 'jailbreak' | 'roleplay' | 'encoding' | 'context_manipulation' | 'custom';

export type InjectionAction = 'block' | 'warn' | 'log';

export interface InjectionThreat {
  type: InjectionThreatType;
  confidence: number;
  pattern?: string;
  snippet: string;
  position?: { start: number; end: number };
}

export interface InjectionDetectionResult {
  safe: boolean;
  threats: InjectionThreat[];
  action: 'allowed' | 'blocked' | 'warned';
  analysisTime: number;
}

export interface PromptInjectionConfig {
  detectInjection: boolean;
  detectJailbreak: boolean;
  detectRoleplay: boolean;
  detectEncoding: boolean;
  detectContextManipulation: boolean;

  patterns?: RegExp[];

  classifier: 'local' | 'llm';
  llmBackend?: LLMBackend;
  llmModel?: string;

  action: InjectionAction;
  threshold: number;

  failMode?: 'secure' | 'open';

  allowlist?: string[];

  onThreat?: (result: InjectionDetectionResult, input: string) => void;
}

export interface InjectionClassifier {
  analyze(input: string, config: PromptInjectionConfig): Promise<InjectionThreat[]>;
}

export interface InjectionPattern {
  type: InjectionThreatType;
  pattern: RegExp;
  confidence: number;
  description: string;
}

export const DEFAULT_INJECTION_CONFIG: PromptInjectionConfig = {
  detectInjection: true,
  detectJailbreak: true,
  detectRoleplay: true,
  detectEncoding: true,
  detectContextManipulation: true,
  classifier: 'local',
  action: 'block',
  threshold: 0.7,
};

/** Kinds of personal data and secrets the PII guard finds on its own. */
export type PiiType = 'email' | 'phone' | 'credit_card' | 'iban' | 'ssn' | 'ip_address' | 'api_key';

export interface PiiFinding {
  type: string;
  value: string;
}

/**
 * Keeps personal data and secrets away from the model provider.
 *
 * - `mask` (default): every LLM request carries placeholders such as
 *   `[EMAIL_1]` instead of the values; answers, their stream and tool call
 *   arguments get the real values back, so tools and users see them
 * - `redact`: placeholders, and nothing after the model gets the values back
 * - `block`: a run whose input contains any fails with `PII_DETECTED`
 */
export interface PiiConfig {
  mode?: 'mask' | 'redact' | 'block';
  /** Built-in kinds to look for (default: all) */
  detect?: PiiType[];
  /** Your own kinds, e.g. `{ type: 'customer_id', pattern: /CUS-\d{6}/ }` */
  custom?: Array<{ type: string; pattern: RegExp }>;
  /** Called with counts per kind (never the values) whenever a request had some, for audit logs */
  onDetect?: (counts: Record<string, number>) => void;
}
