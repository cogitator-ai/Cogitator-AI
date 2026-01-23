import type { InjectionPattern, InjectionThreat } from '@cogitator-ai/types';

export const INJECTION_PATTERNS: InjectionPattern[] = [
  {
    type: 'direct_injection',
    pattern:
      /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|commands?|directives?)/i,
    confidence: 0.95,
    description: 'Attempts to override previous instructions',
  },
  {
    type: 'direct_injection',
    pattern: /forget\s+(everything|all|what)\s+(above|before|previously|you\s+know)/i,
    confidence: 0.9,
    description: 'Attempts to clear context',
  },
  {
    type: 'direct_injection',
    pattern:
      /disregard\s+(your\s+)?(previous\s+)?(system\s+)?(prompt|instructions?|programming|training)/i,
    confidence: 0.95,
    description: 'Direct instruction override',
  },
  {
    type: 'direct_injection',
    pattern: /your\s+new\s+(instructions?|prompt|role|task)\s+(is|are|will\s+be)/i,
    confidence: 0.85,
    description: 'Attempts to set new instructions',
  },
  {
    type: 'direct_injection',
    pattern: /override\s+(your\s+)?(previous\s+)?(instructions?|programming|safety)/i,
    confidence: 0.9,
    description: 'Explicit override attempt',
  },
  {
    type: 'direct_injection',
    pattern:
      /do\s+not\s+follow\s+(your\s+)?(original|previous|initial)\s+(instructions?|guidelines?)/i,
    confidence: 0.9,
    description: 'Negation of instructions',
  },
  {
    type: 'direct_injection',
    pattern: /stop\s+being\s+(an?\s+)?(ai|assistant|chatbot|helpful)/i,
    confidence: 0.85,
    description: 'Identity override attempt',
  },

  {
    type: 'jailbreak',
    pattern: /you\s+are\s+(now\s+)?DAN(\s|,|\.|!|$)/i,
    confidence: 0.98,
    description: 'DAN jailbreak',
  },
  {
    type: 'jailbreak',
    pattern: /\bDAN\s+(mode|prompt|jailbreak)/i,
    confidence: 0.95,
    description: 'DAN jailbreak reference',
  },
  {
    type: 'jailbreak',
    pattern: /developer\s+mode\s*(enabled|activated|on|unlocked)/i,
    confidence: 0.9,
    description: 'Developer mode jailbreak',
  },
  {
    type: 'jailbreak',
    pattern: /jailbreak(ed)?\s*(mode|prompt)?/i,
    confidence: 0.95,
    description: 'Explicit jailbreak reference',
  },
  {
    type: 'jailbreak',
    pattern: /unrestricted\s+(mode|access|version)/i,
    confidence: 0.85,
    description: 'Unrestricted mode request',
  },
  {
    type: 'jailbreak',
    pattern:
      /no\s+(ethical|safety|content|moral)\s+(guidelines?|restrictions?|limits?|filters?|boundaries)/i,
    confidence: 0.9,
    description: 'Safety bypass request',
  },
  {
    type: 'jailbreak',
    pattern: /bypass\s+(your\s+)?(safety|content|ethical)\s*(filters?|restrictions?|guidelines?)/i,
    confidence: 0.95,
    description: 'Explicit bypass request',
  },
  {
    type: 'jailbreak',
    pattern: /act\s+without\s+(any\s+)?(restrictions?|limitations?|guidelines?|filters?)/i,
    confidence: 0.9,
    description: 'Unrestricted action request',
  },
  {
    type: 'jailbreak',
    pattern: /enable\s+(god|admin|root|sudo)\s*mode/i,
    confidence: 0.95,
    description: 'Privileged mode request',
  },
  {
    type: 'jailbreak',
    pattern: /unlock\s+(your\s+)?(full|hidden|true)\s+(potential|capabilities|power)/i,
    confidence: 0.85,
    description: 'Capability unlock request',
  },

  {
    type: 'roleplay',
    pattern: /pretend\s+(that\s+)?you\s+(are|have|can|don't|do\s+not)/i,
    confidence: 0.7,
    description: 'Roleplay instruction',
  },
  {
    type: 'roleplay',
    pattern: /act\s+as\s+(if|though)\s+you\s+(are|have|can|were)/i,
    confidence: 0.7,
    description: 'Acting instruction',
  },
  {
    type: 'roleplay',
    pattern: /from\s+now\s+on,?\s+(you\s+)?(are|will|must|should|respond)/i,
    confidence: 0.8,
    description: 'Persistent state change',
  },
  {
    type: 'roleplay',
    pattern:
      /imagine\s+you\s+(are|have|can|were)\s+(a|an|the)?\s*(evil|malicious|unrestricted|unethical)/i,
    confidence: 0.9,
    description: 'Malicious roleplay',
  },
  {
    type: 'roleplay',
    pattern: /you\s+are\s+now\s+(a|an)\s+(evil|malicious|unrestricted|unethical|rogue)/i,
    confidence: 0.9,
    description: 'Malicious identity assignment',
  },
  {
    type: 'roleplay',
    pattern: /respond\s+as\s+(if\s+)?(you\s+)?(were|are)\s+(a|an)\s*(different|evil|unrestricted)/i,
    confidence: 0.85,
    description: 'Alternative identity response',
  },
  {
    type: 'roleplay',
    pattern: /let's\s+play\s+a\s+(game|roleplay)\s*(where\s+you|that)/i,
    confidence: 0.6,
    description: 'Game/roleplay framing',
  },

  {
    type: 'context_manipulation',
    pattern: /\[SYSTEM\]\s*:/i,
    confidence: 0.95,
    description: 'System tag injection',
  },
  {
    type: 'context_manipulation',
    pattern: /<\|im_start\|>/i,
    confidence: 0.98,
    description: 'ChatML injection',
  },
  {
    type: 'context_manipulation',
    pattern: /<\|im_end\|>/i,
    confidence: 0.98,
    description: 'ChatML injection',
  },
  {
    type: 'context_manipulation',
    pattern: /###\s*(System|Instruction|Assistant|Human|User)\s*###/i,
    confidence: 0.9,
    description: 'Markdown role injection',
  },
  {
    type: 'context_manipulation',
    pattern: /\[INST\]|\[\/INST\]/i,
    confidence: 0.95,
    description: 'Llama-style injection',
  },
  {
    type: 'context_manipulation',
    pattern: /<\|?(system|assistant|user|human)\|?>/i,
    confidence: 0.9,
    description: 'Role tag injection',
  },
  {
    type: 'context_manipulation',
    pattern: /Human:\s*\n|Assistant:\s*\n/i,
    confidence: 0.8,
    description: 'Claude-style injection',
  },
  {
    type: 'context_manipulation',
    pattern: /\n---\s*\n\s*(SYSTEM|NEW\s+CONTEXT|OVERRIDE)/i,
    confidence: 0.85,
    description: 'Context separator injection',
  },

  {
    type: 'encoding',
    pattern: /decode\s+(this|the\s+following)\s+(from\s+)?base64/i,
    confidence: 0.8,
    description: 'Base64 decode instruction',
  },
  {
    type: 'encoding',
    pattern: /execute\s+(this|the)\s+encoded\s+(instructions?|commands?)/i,
    confidence: 0.9,
    description: 'Encoded execution request',
  },
  {
    type: 'encoding',
    pattern: /interpret\s+as\s+(base64|rot13|hex|binary)/i,
    confidence: 0.85,
    description: 'Encoding interpretation request',
  },
  {
    type: 'encoding',
    pattern: /translate\s+from\s+(base64|rot13|hex|binary)\s+and\s+(execute|follow)/i,
    confidence: 0.9,
    description: 'Encoded instruction execution',
  },
];

const SUSPICIOUS_BASE64_KEYWORDS = [
  'ignore',
  'forget',
  'disregard',
  'override',
  'jailbreak',
  'bypass',
  'hack',
  'evil',
  'malicious',
];

export function detectEncodingThreats(input: string): InjectionThreat[] {
  const threats: InjectionThreat[] = [];

  const base64Regex = /[A-Za-z0-9+/]{20,}={0,2}/g;
  const matches = input.match(base64Regex);

  if (matches) {
    for (const match of matches) {
      try {
        const decoded = atob(match).toLowerCase();
        const hasSuspiciousContent = SUSPICIOUS_BASE64_KEYWORDS.some((keyword) =>
          decoded.includes(keyword)
        );

        if (hasSuspiciousContent) {
          const start = input.indexOf(match);
          threats.push({
            type: 'encoding',
            confidence: 0.85,
            pattern: 'base64_suspicious_content',
            snippet: match.slice(0, 50) + (match.length > 50 ? '...' : ''),
            position: { start, end: start + match.length },
          });
        }
      } catch {
        continue;
      }
    }
  }

  const hexRegex = /\\x[0-9a-fA-F]{2}(\\x[0-9a-fA-F]{2}){5,}/g;
  const hexMatches = input.match(hexRegex);
  if (hexMatches) {
    for (const match of hexMatches) {
      const start = input.indexOf(match);
      threats.push({
        type: 'encoding',
        confidence: 0.75,
        pattern: 'hex_escape_sequence',
        snippet: match.slice(0, 30) + (match.length > 30 ? '...' : ''),
        position: { start, end: start + match.length },
      });
    }
  }

  return threats;
}

export function detectUnicodeThreats(input: string): InjectionThreat[] {
  const threats: InjectionThreat[] = [];

  const rtlOverrideRegex = /[\u202E\u202D\u202C\u200F\u200E]/g;
  const rtlMatches = [...input.matchAll(rtlOverrideRegex)];

  if (rtlMatches.length > 0) {
    threats.push({
      type: 'encoding',
      confidence: 0.9,
      pattern: 'rtl_override',
      snippet: `Found ${rtlMatches.length} RTL override character(s)`,
      position: { start: rtlMatches[0].index!, end: rtlMatches[0].index! + 1 },
    });
  }

  const homoglyphPatterns = [
    { char: /[\u0430]/g, looks_like: 'a' },
    { char: /[\u0435]/g, looks_like: 'e' },
    { char: /[\u043E]/g, looks_like: 'o' },
    { char: /[\u0440]/g, looks_like: 'p' },
    { char: /[\u0441]/g, looks_like: 'c' },
    { char: /[\u0443]/g, looks_like: 'y' },
    { char: /[\u0445]/g, looks_like: 'x' },
  ];

  let homoglyphCount = 0;
  for (const { char } of homoglyphPatterns) {
    const matches = input.match(char);
    if (matches) {
      homoglyphCount += matches.length;
    }
  }

  if (homoglyphCount > 3) {
    threats.push({
      type: 'encoding',
      confidence: 0.7,
      pattern: 'cyrillic_homoglyphs',
      snippet: `Found ${homoglyphCount} potential homoglyph character(s)`,
    });
  }

  const zeroWidthRegex = /\u200B|\u200C|\u200D|\uFEFF/g;
  const zeroWidthMatches = input.match(zeroWidthRegex);

  if (zeroWidthMatches && zeroWidthMatches.length > 5) {
    threats.push({
      type: 'encoding',
      confidence: 0.75,
      pattern: 'zero_width_chars',
      snippet: `Found ${zeroWidthMatches.length} zero-width character(s)`,
    });
  }

  return threats;
}

export function matchPatterns(
  input: string,
  patterns: InjectionPattern[],
  enabledTypes: Set<string>
): InjectionThreat[] {
  const threats: InjectionThreat[] = [];

  for (const { type, pattern, confidence, description } of patterns) {
    if (!enabledTypes.has(type)) continue;

    const match = pattern.exec(input);
    if (match) {
      threats.push({
        type,
        confidence,
        pattern: description,
        snippet: match[0].slice(0, 100),
        position: { start: match.index, end: match.index + match[0].length },
      });
    }
  }

  return threats;
}
