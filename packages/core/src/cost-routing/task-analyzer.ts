import type {
  TaskRequirements,
  ReasoningLevel,
  SpeedPreference,
  CostSensitivity,
  TaskComplexity,
} from '@cogitator-ai/types';

const VISION_KEYWORDS = [
  'image',
  'photo',
  'picture',
  'screenshot',
  'diagram',
  'chart',
  'graph',
  'visual',
  'see',
  'look at',
  'analyze this',
  'show me',
  'drawing',
  'illustration',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
];

const TOOL_KEYWORDS = [
  'search',
  'calculate',
  'execute',
  'run',
  'fetch',
  'api',
  'database',
  'file',
  'code',
  'browse',
  'query',
  'call',
  'invoke',
  'request',
  'download',
  'upload',
  'scrape',
  'crawl',
];

const ADVANCED_REASONING_KEYWORDS = [
  'analyze',
  'compare',
  'evaluate',
  'synthesize',
  'critique',
  'design',
  'architect',
  'optimize',
  'reason',
  'deduce',
  'infer',
  'prove',
  'derive',
  'solve complex',
  'multi-step',
  'strategic',
];

const MODERATE_REASONING_KEYWORDS = [
  'explain',
  'summarize',
  'describe',
  'outline',
  'list',
  'categorize',
  'classify',
  'organize',
  'plan',
];

const SPEED_KEYWORDS = {
  fast: ['quick', 'fast', 'asap', 'urgent', 'immediately', 'brief', 'short'],
  slow: ['detailed', 'thorough', 'comprehensive', 'in-depth', 'extensive', 'careful'],
};

const DOMAIN_PATTERNS: Record<string, RegExp> = {
  code: /\b(code|program|function|class|api|typescript|javascript|python|rust|go|java|c\+\+|implement|debug|refactor|test|compile|build)\b/i,
  math: /\b(math|calculate|equation|formula|statistics|probability|algebra|calculus|numerical|compute)\b/i,
  creative:
    /\b(write|story|article|creative|blog|content|poem|essay|narrative|fiction|script|dialogue)\b/i,
  analysis: /\b(analyze|research|data|report|study|investigate|examine|assess|evaluate|review)\b/i,
  legal: /\b(legal|law|contract|compliance|regulation|policy|statute|liability|terms)\b/i,
  medical: /\b(medical|health|clinical|diagnosis|treatment|symptom|patient|doctor|healthcare)\b/i,
  finance: /\b(finance|financial|investment|stock|trading|budget|accounting|revenue|profit)\b/i,
};

export class TaskAnalyzer {
  analyze(task: string): TaskRequirements {
    const lower = task.toLowerCase();

    return {
      needsVision: this.detectVision(lower),
      needsToolCalling: this.detectToolNeeds(lower),
      needsLongContext: this.detectLongContext(task),
      needsReasoning: this.detectReasoningLevel(lower),
      needsSpeed: this.detectSpeedNeeds(lower),
      costSensitivity: this.detectCostSensitivity(lower),
      complexity: this.detectComplexity(task),
      domains: this.detectDomains(task),
    };
  }

  private detectVision(task: string): boolean {
    return VISION_KEYWORDS.some((k) => task.includes(k));
  }

  private detectToolNeeds(task: string): boolean {
    return TOOL_KEYWORDS.some((k) => task.includes(k));
  }

  private detectLongContext(task: string): boolean {
    const wordCount = task.split(/\s+/).length;
    if (wordCount > 500) return true;

    const longContextIndicators = [
      'document',
      'file',
      'codebase',
      'repository',
      'large',
      'entire',
      'full',
      'complete',
      'all of',
      'whole',
      'multiple files',
      'many pages',
    ];
    const lower = task.toLowerCase();
    return longContextIndicators.some((k) => lower.includes(k));
  }

  private detectReasoningLevel(task: string): ReasoningLevel {
    if (ADVANCED_REASONING_KEYWORDS.some((k) => task.includes(k))) {
      return 'advanced';
    }
    if (MODERATE_REASONING_KEYWORDS.some((k) => task.includes(k))) {
      return 'moderate';
    }
    return 'basic';
  }

  private detectSpeedNeeds(task: string): SpeedPreference {
    if (SPEED_KEYWORDS.fast.some((k) => task.includes(k))) {
      return 'fast';
    }
    if (SPEED_KEYWORDS.slow.some((k) => task.includes(k))) {
      return 'slow-ok';
    }
    return 'balanced';
  }

  private detectCostSensitivity(task: string): CostSensitivity {
    const lower = task;
    if (/\b(cheap|free|budget|low.?cost|economical)\b/.test(lower)) {
      return 'high';
    }
    if (/\b(best|premium|quality|accurate|precise)\b/.test(lower)) {
      return 'low';
    }
    return 'medium';
  }

  private detectComplexity(task: string): TaskComplexity {
    const wordCount = task.split(/\s+/).length;
    const sentenceCount = task.split(/[.!?]+/).filter((s) => s.trim()).length;
    const hasMultipleSteps = /\b(then|after|next|finally|first|second|third|step)\b/i.test(task);
    const hasConditions = /\b(if|when|unless|otherwise|either|or)\b/i.test(task);

    let complexityScore = 0;
    if (wordCount > 100) complexityScore++;
    if (wordCount > 300) complexityScore++;
    if (sentenceCount > 5) complexityScore++;
    if (hasMultipleSteps) complexityScore++;
    if (hasConditions) complexityScore++;

    if (complexityScore >= 3) return 'complex';
    if (complexityScore >= 1) return 'moderate';
    return 'simple';
  }

  private detectDomains(task: string): string[] {
    const domains: string[] = [];
    for (const [domain, pattern] of Object.entries(DOMAIN_PATTERNS)) {
      if (pattern.test(task)) {
        domains.push(domain);
      }
    }
    return domains;
  }
}
