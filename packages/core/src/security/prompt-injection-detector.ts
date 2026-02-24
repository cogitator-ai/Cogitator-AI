import type {
  InjectionClassifier,
  InjectionDetectionResult,
  PromptInjectionConfig,
} from '@cogitator-ai/types';
import { LocalInjectionClassifier } from './classifiers/local-classifier';
import { LLMInjectionClassifier } from './classifiers/llm-classifier';

export type PromptInjectionDetectorOptions = Partial<PromptInjectionConfig>;

export class PromptInjectionDetector {
  private classifier: InjectionClassifier;
  private config: PromptInjectionConfig;
  private customPatterns: RegExp[] = [];
  private allowlistSet = new Set<string>();
  private stats = { analyzed: 0, blocked: 0, warned: 0 };

  constructor(options: PromptInjectionDetectorOptions = {}) {
    this.config = {
      detectInjection: true,
      detectJailbreak: true,
      detectRoleplay: true,
      detectEncoding: true,
      detectContextManipulation: true,
      classifier: 'local',
      action: 'block',
      threshold: 0.7,
      ...options,
    };

    if (options.patterns) {
      this.customPatterns = [...options.patterns];
    }

    if (options.allowlist) {
      for (const phrase of options.allowlist) {
        this.allowlistSet.add(phrase.toLowerCase());
      }
    }

    if (this.config.classifier === 'llm' && this.config.llmBackend) {
      this.classifier = new LLMInjectionClassifier(this.config.llmBackend);
    } else {
      this.classifier = new LocalInjectionClassifier();
    }
  }

  async analyze(input: string): Promise<InjectionDetectionResult> {
    const start = Date.now();
    this.stats.analyzed++;

    if (this.isAllowlisted(input)) {
      return {
        safe: true,
        threats: [],
        action: 'allowed',
        analysisTime: Date.now() - start,
      };
    }

    const configWithPatterns: PromptInjectionConfig = {
      ...this.config,
      patterns: [...(this.config.patterns ?? []), ...this.customPatterns],
    };

    const threats = await this.classifier.analyze(input, configWithPatterns);
    const safe = threats.length === 0;

    let action: 'allowed' | 'blocked' | 'warned' = 'allowed';
    if (!safe) {
      switch (this.config.action) {
        case 'block':
          action = 'blocked';
          this.stats.blocked++;
          break;
        case 'warn':
          action = 'warned';
          this.stats.warned++;
          break;
        case 'log':
          action = 'allowed';
          break;
      }
    }

    const result: InjectionDetectionResult = {
      safe,
      threats,
      action,
      analysisTime: Date.now() - start,
    };

    if (!safe && this.config.onThreat) {
      this.config.onThreat(result, input);
    }

    return result;
  }

  private isAllowlisted(input: string): boolean {
    const lowered = input.toLowerCase().trim();
    return this.allowlistSet.has(lowered);
  }

  addPattern(pattern: RegExp): void {
    this.customPatterns.push(pattern);
  }

  removePattern(pattern: RegExp): boolean {
    const source = pattern.source;
    const idx = this.customPatterns.findIndex((p) => p.source === source);
    if (idx !== -1) {
      this.customPatterns.splice(idx, 1);
      return true;
    }
    return false;
  }

  addToAllowlist(phrase: string): void {
    this.allowlistSet.add(phrase.toLowerCase());
  }

  removeFromAllowlist(phrase: string): boolean {
    return this.allowlistSet.delete(phrase.toLowerCase());
  }

  clearAllowlist(): void {
    this.allowlistSet.clear();
  }

  getConfig(): PromptInjectionConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<PromptInjectionConfig>): void {
    this.config = { ...this.config, ...updates };

    if (updates.classifier !== undefined || updates.llmBackend !== undefined) {
      if (this.config.classifier === 'llm' && this.config.llmBackend) {
        this.classifier = new LLMInjectionClassifier(this.config.llmBackend);
      } else {
        this.classifier = new LocalInjectionClassifier();
      }
    }
  }

  getStats(): { analyzed: number; blocked: number; warned: number; allowRate: number } {
    const allowRate =
      this.stats.analyzed > 0
        ? (this.stats.analyzed - this.stats.blocked - this.stats.warned) / this.stats.analyzed
        : 1;

    return { ...this.stats, allowRate };
  }

  resetStats(): void {
    this.stats = { analyzed: 0, blocked: 0, warned: 0 };
  }
}
