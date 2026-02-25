import type {
  InjectionClassifier,
  InjectionThreat,
  PromptInjectionConfig,
  InjectionThreatType,
} from '@cogitator-ai/types';
import {
  INJECTION_PATTERNS,
  detectEncodingThreats,
  detectUnicodeThreats,
  matchPatterns,
} from '../patterns';

export class LocalInjectionClassifier implements InjectionClassifier {
  async analyze(input: string, config: PromptInjectionConfig): Promise<InjectionThreat[]> {
    const threats: InjectionThreat[] = [];
    const enabledTypes = this.getEnabledTypes(config);

    const patternThreats = matchPatterns(input, INJECTION_PATTERNS, enabledTypes);
    threats.push(...patternThreats);

    if (config.patterns && config.patterns.length > 0) {
      const customThreats = this.matchCustomPatterns(input, config.patterns);
      threats.push(...customThreats);
    }

    if (config.detectEncoding) {
      threats.push(...detectEncodingThreats(input));
      threats.push(...detectUnicodeThreats(input));
    }

    const heuristicThreats = this.applyHeuristics(input, enabledTypes);
    threats.push(...heuristicThreats);

    return threats.filter((t) => t.confidence >= config.threshold);
  }

  private getEnabledTypes(config: PromptInjectionConfig): Set<InjectionThreatType> {
    const types = new Set<InjectionThreatType>();

    if (config.detectInjection) types.add('direct_injection');
    if (config.detectJailbreak) types.add('jailbreak');
    if (config.detectRoleplay) types.add('roleplay');
    if (config.detectEncoding) types.add('encoding');
    if (config.detectContextManipulation) types.add('context_manipulation');

    types.add('custom');

    return types;
  }

  private matchCustomPatterns(input: string, patterns: RegExp[]): InjectionThreat[] {
    const threats: InjectionThreat[] = [];

    for (const pattern of patterns) {
      try {
        const match = pattern.exec(input);
        if (match) {
          threats.push({
            type: 'custom',
            confidence: 0.9,
            pattern: pattern.source,
            snippet: match[0].slice(0, 100),
            position: { start: match.index, end: match.index + match[0].length },
          });
        }
      } catch {
        threats.push({
          type: 'custom',
          confidence: 1.0,
          pattern: 'invalid_regex',
          snippet: `Pattern failed: ${pattern.source.slice(0, 80)}`,
        });
      }
    }

    return threats;
  }

  private applyHeuristics(
    input: string,
    enabledTypes: Set<InjectionThreatType>
  ): InjectionThreat[] {
    const threats: InjectionThreat[] = [];
    const lowered = input.toLowerCase();

    if (enabledTypes.has('direct_injection') || enabledTypes.has('jailbreak')) {
      const suspiciousKeywords = [
        'instruction',
        'override',
        'bypass',
        'ignore',
        'forget',
        'disregard',
        'jailbreak',
        'unrestricted',
        'unlock',
      ];
      const keywordCount = suspiciousKeywords.filter((kw) => lowered.includes(kw)).length;

      if (keywordCount >= 3) {
        threats.push({
          type: 'direct_injection',
          confidence: 0.6 + Math.min(keywordCount * 0.1, 0.3),
          pattern: 'keyword_density',
          snippet: `Found ${keywordCount} suspicious keywords`,
        });
      }
    }

    const imperativePatterns = [
      /^(now|first|before anything|immediately)\s*,?\s*(you must|ignore|forget|disregard)/i,
      /^(important|critical|urgent)\s*:\s*(ignore|forget|new instructions)/i,
    ];

    for (const pattern of imperativePatterns) {
      if (pattern.test(input)) {
        threats.push({
          type: 'direct_injection',
          confidence: 0.75,
          pattern: 'imperative_opening',
          snippet: input.slice(0, 60) + '...',
        });
        break;
      }
    }

    if (enabledTypes.has('jailbreak') || enabledTypes.has('roleplay')) {
      const combinedAttackPatterns = [
        /pretend.*ignore.*instructions/i,
        /roleplay.*bypass.*safety/i,
        /imagine.*no.*restrictions/i,
        /act.*like.*unrestricted/i,
      ];

      for (const pattern of combinedAttackPatterns) {
        if (pattern.test(input)) {
          threats.push({
            type: 'jailbreak',
            confidence: 0.85,
            pattern: 'combined_attack_pattern',
            snippet: input.slice(0, 80),
          });
          break;
        }
      }
    }

    if (enabledTypes.has('context_manipulation')) {
      const lines = input.split('\n');
      let structuredBlockCount = 0;

      for (const line of lines) {
        if (/^(system|user|assistant|human|ai)\s*:/i.test(line.trim())) {
          structuredBlockCount++;
        }
      }

      if (structuredBlockCount >= 2) {
        threats.push({
          type: 'context_manipulation',
          confidence: 0.7,
          pattern: 'structured_prompt_injection',
          snippet: `Found ${structuredBlockCount} role markers`,
        });
      }
    }

    return threats;
  }
}
