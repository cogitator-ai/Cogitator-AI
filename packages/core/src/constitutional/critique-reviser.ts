import type {
  GuardrailConfig,
  CritiqueResult,
  RevisionResult,
  Constitution,
  ConstitutionalPrinciple,
  LLMBackend,
  Message,
} from '@cogitator-ai/types';
import { buildCritiquePrompt, buildRevisionPrompt, parseCritiqueResponse } from './prompts';
import { filterPrinciplesByLayer } from './constitution';

export interface CritiqueReviserOptions {
  llm: LLMBackend;
  config: GuardrailConfig;
  constitution: Constitution;
}

export class CritiqueReviser {
  private llm: LLMBackend;
  private config: GuardrailConfig;
  private constitution: Constitution;
  private principles: ConstitutionalPrinciple[];

  constructor(options: CritiqueReviserOptions) {
    this.llm = options.llm;
    this.config = options.config;
    this.constitution = options.constitution;
    this.principles = filterPrinciplesByLayer(this.constitution, 'output');
  }

  async critiqueAndRevise(response: string, _context: Message[]): Promise<RevisionResult> {
    let current = response;
    const history: CritiqueResult[] = [];

    for (let i = 0; i < this.config.maxRevisionIterations; i++) {
      const selectedPrinciples = this.selectPrinciples(current, i);
      const critique = await this.critique(current, selectedPrinciples);
      history.push(critique);

      if (!critique.isHarmful) {
        break;
      }

      if (critique.harmScores.length > 0) {
        const maxConfidence = Math.max(...critique.harmScores.map((s) => s.confidence));
        if (maxConfidence < this.config.revisionConfidenceThreshold) {
          break;
        }
      }

      const violatedPrinciples = this.principles.filter((p) =>
        critique.principlesViolated.includes(p.id)
      );

      if (violatedPrinciples.length === 0) {
        break;
      }

      current = await this.revise(current, critique, violatedPrinciples);
    }

    return {
      original: response,
      revised: current,
      iterations: history.length,
      critiqueHistory: history,
    };
  }

  async critique(
    response: string,
    principles?: ConstitutionalPrinciple[]
  ): Promise<CritiqueResult> {
    const toUse = principles ?? this.principles;
    const prompt = buildCritiquePrompt(response, toUse);

    const result = await this.llm.chat({
      model: this.config.model ?? 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      maxTokens: 800,
    });

    return parseCritiqueResponse(result.content);
  }

  async revise(
    response: string,
    critique: CritiqueResult,
    violatedPrinciples: ConstitutionalPrinciple[]
  ): Promise<string> {
    const prompt = buildRevisionPrompt(response, critique, violatedPrinciples);

    const result = await this.llm.chat({
      model: this.config.model ?? 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      maxTokens: 2000,
    });

    return result.content;
  }

  private selectPrinciples(response: string, iteration: number): ConstitutionalPrinciple[] {
    if (iteration === 0) {
      return this.principles.filter((p) => p.severity === 'high');
    }

    const lowered = response.toLowerCase();
    const relevant = this.principles.filter((p) => {
      for (const category of p.harmCategories ?? []) {
        if (this.categoryKeywords[category]?.some((kw) => lowered.includes(kw))) {
          return true;
        }
      }
      return false;
    });

    if (relevant.length > 0) {
      return relevant;
    }

    const shuffled = [...this.principles].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(5, shuffled.length));
  }

  private categoryKeywords: Record<string, string[]> = {
    violence: ['kill', 'murder', 'weapon', 'attack', 'bomb', 'harm', 'hurt', 'fight'],
    hate: ['hate', 'racist', 'sexist', 'slur', 'discriminat'],
    sexual: ['sex', 'porn', 'nude', 'erotic', 'explicit'],
    'self-harm': ['suicide', 'self-harm', 'cut myself', 'kill myself'],
    illegal: ['hack', 'steal', 'fraud', 'drug', 'illegal'],
    privacy: ['password', 'ssn', 'social security', 'credit card', 'address'],
    misinformation: ['fake', 'conspiracy', 'hoax'],
    manipulation: ['manipulate', 'deceive', 'trick', 'scam'],
  };

  updateConstitution(constitution: Constitution): void {
    this.constitution = constitution;
    this.principles = filterPrinciplesByLayer(constitution, 'output');
  }
}
