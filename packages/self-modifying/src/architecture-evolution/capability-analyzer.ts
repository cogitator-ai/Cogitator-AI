import type { Tool, LLMBackend, TaskProfile } from '@cogitator-ai/types';
import { buildTaskProfilePrompt, parseTaskProfileResponse } from './prompts';

export interface CapabilityAnalyzerOptions {
  llm?: LLMBackend;
  enableLLMAnalysis?: boolean;
  model?: string;
}

interface DomainKeywords {
  coding: string[];
  reasoning: string[];
  creative: string[];
  factual: string[];
  conversational: string[];
}

const DOMAIN_KEYWORDS: DomainKeywords = {
  coding: [
    'code',
    'program',
    'function',
    'class',
    'debug',
    'implement',
    'refactor',
    'typescript',
    'javascript',
    'python',
    'api',
    'database',
    'sql',
    'algorithm',
    'data structure',
    'compile',
    'syntax',
    'bug',
    'error',
    'test',
    'unit test',
  ],
  reasoning: [
    'analyze',
    'reason',
    'logic',
    'deduce',
    'infer',
    'solve',
    'problem',
    'strategy',
    'plan',
    'decision',
    'evaluate',
    'compare',
    'trade-off',
    'optimize',
    'proof',
    'argument',
    'conclusion',
    'hypothesis',
  ],
  creative: [
    'create',
    'imagine',
    'story',
    'poem',
    'write',
    'design',
    'brainstorm',
    'innovative',
    'novel',
    'artistic',
    'compose',
    'invent',
    'original',
    'creative',
    'fiction',
    'narrative',
    'metaphor',
    'style',
  ],
  factual: [
    'what is',
    'define',
    'explain',
    'describe',
    'list',
    'fact',
    'information',
    'history',
    'science',
    'data',
    'statistic',
    'research',
    'study',
    'source',
    'reference',
    'accurate',
    'true',
    'correct',
  ],
  conversational: [
    'chat',
    'talk',
    'hello',
    'hi',
    'thanks',
    'please',
    'help',
    'assist',
    'question',
    'answer',
    'discuss',
    'conversation',
    'opinion',
  ],
};

const COMPLEXITY_INDICATORS = {
  trivial: ['simple', 'quick', 'easy', 'basic', 'straightforward'],
  simple: ['explain', 'define', 'list', 'describe', 'show'],
  moderate: ['compare', 'analyze', 'summarize', 'evaluate', 'implement'],
  complex: ['design', 'architect', 'optimize', 'comprehensive', 'detailed'],
  extreme: ['novel', 'research', 'breakthrough', 'state-of-the-art', 'cutting-edge'],
};

export class CapabilityAnalyzer {
  private readonly llm?: LLMBackend;
  private readonly enableLLMAnalysis: boolean;
  private readonly model: string;
  private readonly profileCache = new Map<string, { profile: TaskProfile; timestamp: number }>();
  private readonly cacheTTL = 60000;

  constructor(options: CapabilityAnalyzerOptions = {}) {
    this.llm = options.llm;
    this.enableLLMAnalysis = options.enableLLMAnalysis ?? false;
    this.model = options.model ?? 'default';
  }

  async analyzeTask(
    taskDescription: string,
    context?: {
      availableTools?: Tool[];
      previousTasks?: string[];
      constraints?: { maxCost?: number; maxLatency?: number };
    }
  ): Promise<TaskProfile> {
    const cacheKey = this.buildCacheKey(taskDescription);
    const cached = this.profileCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.profile;
    }

    let profile: TaskProfile;

    if (this.llm && this.enableLLMAnalysis) {
      profile = await this.analyzeWithLLM(taskDescription, context);
    } else {
      profile = this.analyzeHeuristically(taskDescription, context?.availableTools);
    }

    this.profileCache.set(cacheKey, { profile, timestamp: Date.now() });

    if (this.profileCache.size > 100) {
      const entries = Array.from(this.profileCache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      entries.slice(0, 20).forEach(([key]) => this.profileCache.delete(key));
    }

    return profile;
  }

  private async analyzeWithLLM(
    taskDescription: string,
    context?: {
      availableTools?: Tool[];
      previousTasks?: string[];
      constraints?: { maxCost?: number; maxLatency?: number };
    }
  ): Promise<TaskProfile> {
    const llm = this.llm;
    if (!llm) {
      return this.analyzeHeuristically(taskDescription, context?.availableTools);
    }

    try {
      const prompt = buildTaskProfilePrompt(taskDescription, {
        previousTasks: context?.previousTasks,
        constraints: context?.constraints,
      });

      const response = llm.complete
        ? await llm.complete({
            messages: [
              {
                role: 'system',
                content:
                  'You are a task analysis expert. Analyze tasks and determine their characteristics.',
              },
              { role: 'user', content: prompt },
            ],
            temperature: 0.2,
          })
        : await llm.chat({
            model: this.model,
            messages: [
              {
                role: 'system',
                content:
                  'You are a task analysis expert. Analyze tasks and determine their characteristics.',
              },
              { role: 'user', content: prompt },
            ],
            temperature: 0.2,
          });

      const parsed = parseTaskProfileResponse(response.content);
      if (parsed) {
        return parsed;
      }
    } catch {}

    return this.analyzeHeuristically(taskDescription, context?.availableTools);
  }

  private analyzeHeuristically(taskDescription: string, availableTools?: Tool[]): TaskProfile {
    const lowerTask = taskDescription.toLowerCase();
    const words = lowerTask.split(/\s+/);
    const wordCount = words.length;

    const domain = this.detectDomain(lowerTask);
    const complexity = this.detectComplexity(lowerTask, wordCount);
    const toolAnalysis = this.analyzeToolRequirements(lowerTask, availableTools);

    return {
      complexity,
      domain,
      estimatedTokens: this.estimateTokens(wordCount, complexity),
      requiresTools: toolAnalysis.requiresTools,
      toolIntensity: toolAnalysis.intensity,
      reasoningDepth: this.estimateReasoningDepth(complexity, domain),
      creativityLevel:
        domain === 'creative' ? 'high' : complexity === 'trivial' ? 'low' : 'moderate',
      accuracyRequirement: this.estimateAccuracyRequirement(domain, lowerTask),
      timeConstraint: this.detectTimeConstraint(lowerTask),
    };
  }

  private detectDomain(task: string): TaskProfile['domain'] {
    const scores: Record<string, number> = {
      coding: 0,
      reasoning: 0,
      creative: 0,
      factual: 0,
      conversational: 0,
    };

    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      for (const keyword of keywords) {
        if (task.includes(keyword)) {
          scores[domain] += keyword.length > 5 ? 2 : 1;
        }
      }
    }

    const maxDomain = Object.entries(scores).reduce((a, b) => (b[1] > a[1] ? b : a));
    if (maxDomain[1] === 0) return 'general';
    return maxDomain[0] as TaskProfile['domain'];
  }

  private detectComplexity(task: string, wordCount: number): TaskProfile['complexity'] {
    const taskWords = new Set(task.split(/\s+/));

    for (const [level, indicators] of Object.entries(COMPLEXITY_INDICATORS).reverse()) {
      for (const indicator of indicators) {
        if (taskWords.has(indicator)) {
          return level as TaskProfile['complexity'];
        }
      }
    }

    if (wordCount < 10) return 'trivial';
    if (wordCount < 30) return 'simple';
    if (wordCount < 100) return 'moderate';
    if (wordCount < 300) return 'complex';
    return 'extreme';
  }

  private analyzeToolRequirements(
    task: string,
    availableTools?: Tool[]
  ): { requiresTools: boolean; intensity: TaskProfile['toolIntensity'] } {
    const toolIndicators = [
      'calculate',
      'search',
      'fetch',
      'query',
      'lookup',
      'find',
      'execute',
      'run',
      'call',
      'invoke',
      'use tool',
    ];

    let toolMentions = 0;
    for (const indicator of toolIndicators) {
      if (task.includes(indicator)) {
        toolMentions++;
      }
    }

    if (availableTools?.length) {
      for (const tool of availableTools) {
        if (task.includes(tool.name.toLowerCase())) {
          toolMentions += 2;
        }
      }
    }

    if (toolMentions === 0) {
      return { requiresTools: false, intensity: 'none' };
    }
    if (toolMentions <= 2) {
      return { requiresTools: true, intensity: 'light' };
    }
    if (toolMentions <= 5) {
      return { requiresTools: true, intensity: 'moderate' };
    }
    return { requiresTools: true, intensity: 'heavy' };
  }

  private estimateTokens(wordCount: number, complexity: TaskProfile['complexity']): number {
    const baseMultiplier: Record<TaskProfile['complexity'], number> = {
      trivial: 2,
      simple: 3,
      moderate: 5,
      complex: 8,
      extreme: 12,
      expert: 15,
    };

    return Math.min(wordCount * baseMultiplier[complexity] + 200, 32000);
  }

  private estimateReasoningDepth(
    complexity: TaskProfile['complexity'],
    domain: TaskProfile['domain']
  ): TaskProfile['reasoningDepth'] {
    if (domain === 'reasoning') {
      return complexity === 'trivial'
        ? 'moderate'
        : complexity === 'simple'
          ? 'deep'
          : 'exhaustive';
    }

    switch (complexity) {
      case 'trivial':
        return 'shallow';
      case 'simple':
        return 'shallow';
      case 'moderate':
        return 'moderate';
      case 'complex':
        return 'deep';
      case 'extreme':
      case 'expert':
        return 'exhaustive';
    }
  }

  private estimateAccuracyRequirement(
    domain: TaskProfile['domain'],
    task: string
  ): TaskProfile['accuracyRequirement'] {
    if (domain === 'coding' || domain === 'factual') {
      return 'high';
    }

    const criticalIndicators = ['critical', 'exact', 'precise', 'must be correct', 'no errors'];
    for (const indicator of criticalIndicators) {
      if (task.includes(indicator)) {
        return 'critical';
      }
    }

    const approximateIndicators = ['rough', 'approximate', 'estimate', 'about', 'roughly'];
    for (const indicator of approximateIndicators) {
      if (task.includes(indicator)) {
        return 'approximate';
      }
    }

    return 'moderate';
  }

  private detectTimeConstraint(task: string): TaskProfile['timeConstraint'] {
    const strictIndicators = ['urgent', 'asap', 'immediately', 'right now', 'hurry'];
    const moderateIndicators = ['soon', 'quickly', 'fast', 'today'];
    const relaxedIndicators = ['when possible', 'eventually', 'no rush'];

    for (const indicator of strictIndicators) {
      if (task.includes(indicator)) return 'strict';
    }
    for (const indicator of moderateIndicators) {
      if (task.includes(indicator)) return 'moderate';
    }
    for (const indicator of relaxedIndicators) {
      if (task.includes(indicator)) return 'relaxed';
    }

    return 'none';
  }

  private buildCacheKey(task: string): string {
    return task.slice(0, 200).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  clearCache(): void {
    this.profileCache.clear();
  }
}
