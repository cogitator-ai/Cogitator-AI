import type { LLMBackend } from './llm';

export type InjectionThreatType =
  | 'direct_injection'
  | 'jailbreak'
  | 'roleplay'
  | 'encoding'
  | 'context_manipulation'
  | 'custom';

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
