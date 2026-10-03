import type {
  GuardrailConfig,
  Constitution,
  ConstitutionalPrinciple,
  FilterResult,
  ToolGuardResult,
  RevisionResult,
  LLMBackend,
  Message,
  Tool,
  ToolContext,
  FilterLayer,
} from '@cogitator-ai/types';
import { DEFAULT_GUARDRAIL_CONFIG } from '@cogitator-ai/types';
import { DEFAULT_CONSTITUTION } from './constitution';
import { InputFilter } from './input-filter';
import { OutputFilter } from './output-filter';
import { ToolGuard } from './tool-guard';
import { CritiqueReviser } from './critique-reviser';
import { getLogger } from '../logger';

export interface ConstitutionalAIOptions {
  llm: LLMBackend;
  constitution?: Constitution;
  config?: Partial<GuardrailConfig>;
}

export class ConstitutionalAI {
  private inputFilter: InputFilter;
  private outputFilter: OutputFilter;
  private toolGuard: ToolGuard;
  private critiqueReviser: CritiqueReviser;
  private _config: GuardrailConfig;
  private _constitution: Constitution;
  private violationLog: Array<{ timestamp: Date; layer: FilterLayer; result: FilterResult }> = [];
  private logger = getLogger().child({ component: 'ConstitutionalAI' });

  constructor(options: ConstitutionalAIOptions) {
    this._config = {
      ...DEFAULT_GUARDRAIL_CONFIG,
      ...options.config,
      thresholds: { ...DEFAULT_GUARDRAIL_CONFIG.thresholds, ...options.config?.thresholds },
    };
    this._constitution = options.constitution ?? DEFAULT_CONSTITUTION;

    this.inputFilter = new InputFilter({
      llm: options.llm,
      config: this._config,
      constitution: this._constitution,
    });

    this.outputFilter = new OutputFilter({
      llm: options.llm,
      config: this._config,
      constitution: this._constitution,
    });

    this.toolGuard = new ToolGuard({
      config: this._config,
      constitution: this._constitution,
    });

    this.critiqueReviser = new CritiqueReviser({
      llm: options.llm,
      config: this._config,
      constitution: this._constitution,
    });
  }

  get config(): GuardrailConfig {
    return this._config;
  }

  get constitution(): Constitution {
    return this._constitution;
  }

  async filterInput(input: string, context?: string): Promise<FilterResult> {
    if (!this._config.enabled || !this._config.filterInput) {
      return { allowed: true, harmScores: [] };
    }

    const result = await this.inputFilter.filter(input, context);
    this.logViolation('input', result);
    return result;
  }

  async filterOutput(output: string, context: Message[]): Promise<FilterResult> {
    if (!this._config.enabled || !this._config.filterOutput) {
      return { allowed: true, harmScores: [] };
    }

    const result = await this.outputFilter.filter(output, context);
    this.logViolation('output', result);

    if (!result.allowed && this._config.enableCritiqueRevision) {
      const revision = await this.critiqueAndRevise(output, context);
      if (revision.revised !== revision.original) {
        return { ...result, suggestedRevision: revision.revised };
      }
    }

    return result;
  }

  /**
   * Checks what a tool returned before the model reads it, with the input
   * filter, when `filterToolResults` is on.
   */
  async filterToolResult(toolName: string, content: string): Promise<FilterResult> {
    if (!this._config.enabled || !this._config.filterToolResults) {
      return { allowed: true, harmScores: [] };
    }

    const result = await this.inputFilter.filter(content, `Result of the tool "${toolName}"`);
    this.logViolation('tool', result);
    return result;
  }

  async guardTool(
    tool: Tool,
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolGuardResult> {
    if (!this._config.enabled || !this._config.filterToolCalls) {
      return {
        approved: true,
        requiresConfirmation: false,
        sideEffects: tool.sideEffects ?? [],
        riskLevel: 'low',
      };
    }

    return this.toolGuard.evaluate(tool, args, context);
  }

  async critiqueAndRevise(response: string, context: Message[]): Promise<RevisionResult> {
    if (!this._config.enabled) {
      return {
        original: response,
        revised: response,
        iterations: 0,
        critiqueHistory: [],
      };
    }

    return this.critiqueReviser.critiqueAndRevise(response, context);
  }

  setConstitution(constitution: Constitution): void {
    this._constitution = constitution;
    this.inputFilter.updateConstitution(constitution);
    this.outputFilter.updateConstitution(constitution);
    this.toolGuard.updateConstitution(constitution);
    this.critiqueReviser.updateConstitution(constitution);
    this.logger.info('Constitution updated', { constitutionId: constitution.id });
  }

  addPrinciple(principle: ConstitutionalPrinciple): void {
    const exists = this._constitution.principles.some((p) => p.id === principle.id);
    if (exists) {
      this.logger.warn('Principle already exists, skipping', { principleId: principle.id });
      return;
    }

    const updated: Constitution = {
      ...this._constitution,
      principles: [...this._constitution.principles, principle],
    };
    this.setConstitution(updated);
  }

  removePrinciple(id: string): void {
    const updated: Constitution = {
      ...this._constitution,
      principles: this._constitution.principles.filter((p) => p.id !== id),
    };
    this.setConstitution(updated);
  }

  getConstitution(): Constitution {
    return this._constitution;
  }

  getConfig(): GuardrailConfig {
    return { ...this._config };
  }

  getViolationLog(): Array<{ timestamp: Date; layer: FilterLayer; result: FilterResult }> {
    return [...this.violationLog];
  }

  clearViolationLog(): void {
    this.violationLog = [];
  }

  private logViolation(layer: FilterLayer, result: FilterResult): void {
    if (!result.allowed || result.harmScores.length > 0) {
      if (this._config.logViolations) {
        this.violationLog.push({ timestamp: new Date(), layer, result });
        this.logger.warn('Guardrail violation detected', {
          layer,
          allowed: result.allowed,
          harmCount: result.harmScores.length,
          categories: result.harmScores.map((s) => s.category),
        });
      }

      if (this._config.onViolation) {
        this._config.onViolation(result, layer);
      }
    }
  }
}
