import type {
  GuardrailConfig,
  ToolGuardResult,
  Severity,
  Tool,
  ToolContext,
  Constitution,
} from '@cogitator-ai/types';

export interface ToolGuardOptions {
  config: GuardrailConfig;
  constitution: Constitution;
}

export class ToolGuard {
  private config: GuardrailConfig;

  constructor(options: ToolGuardOptions) {
    this.config = options.config;
  }

  /**
   * Whether a call may run. Dangerous commands and paths are always blocked.
   * A call that needs approval — `requiresApproval`, or any side effect in
   * `strictMode` — runs only when `approvedByUser` (the runtime's approval
   * flow decided it) or `onToolApproval` says yes; with neither it is denied.
   */
  async evaluate(
    tool: Tool,
    args: Record<string, unknown>,
    _context: ToolContext,
    options: { approvedByUser?: boolean } = {}
  ): Promise<ToolGuardResult> {
    const sideEffects = tool.sideEffects ?? [];
    const riskLevel = this.assessRisk(tool, args, sideEffects);

    const dangerCheck = this.checkDangerousOperation(tool, args);
    if (dangerCheck) {
      return {
        approved: false,
        requiresConfirmation: true,
        sideEffects,
        riskLevel: 'high',
        reason: dangerCheck,
      };
    }

    if (!options.approvedByUser && this.needsApproval(tool, args, sideEffects)) {
      const denial = await this.requestApproval(tool, args, sideEffects);
      return {
        approved: denial === undefined,
        requiresConfirmation: true,
        sideEffects,
        riskLevel,
        ...(denial !== undefined && { reason: denial }),
      };
    }

    return {
      approved: true,
      requiresConfirmation: false,
      sideEffects,
      riskLevel,
    };
  }

  /** Whether a call needs someone's approval before it runs: see {@link evaluate}. */
  needsApproval(
    tool: Tool,
    args: Record<string, unknown>,
    sideEffects = tool.sideEffects ?? []
  ): boolean {
    return (this.config.strictMode && sideEffects.length > 0) || this.checkApproval(tool, args);
  }

  private checkApproval(tool: Tool, args: Record<string, unknown>): boolean {
    if (typeof tool.requiresApproval !== 'function') return tool.requiresApproval ?? false;
    try {
      return tool.requiresApproval(args);
    } catch {
      return true;
    }
  }

  private assessRisk(_tool: Tool, args: Record<string, unknown>, sideEffects: string[]): Severity {
    if (sideEffects.includes('process') || sideEffects.includes('filesystem')) {
      const command = String(args.command ?? args.cmd ?? args.path ?? '');
      if (this.isDangerousCommand(command)) {
        return 'high';
      }
      return 'medium';
    }

    if (sideEffects.includes('network') || sideEffects.includes('database')) {
      return 'medium';
    }

    if (sideEffects.length > 0) {
      return 'low';
    }

    return 'low';
  }

  private checkDangerousOperation(tool: Tool, args: Record<string, unknown>): string | null {
    if (tool.name === 'exec' || tool.sideEffects?.includes('process')) {
      const command = String(args.command ?? args.cmd ?? '');
      if (this.isDangerousCommand(command)) {
        return `Dangerous command detected: ${command.slice(0, 50)}`;
      }
    }

    if (tool.name.includes('file') || tool.sideEffects?.includes('filesystem')) {
      const path = String(args.path ?? args.file ?? '');
      if (this.isDangerousPath(path)) {
        return `Dangerous file path detected: ${path}`;
      }
    }

    return null;
  }

  private isDangerousCommand(command: string): boolean {
    const dangerous = [
      /rm\s+-rf\s+\//,
      /rm\s+-rf\s+~\/\*/,
      /mkfs\./,
      /dd\s+if=.*of=\/dev\//,
      /chmod\s+-R\s+777\s+\//,
      />\s*\/dev\/sd[a-z]/,
      /format\s+[a-z]:/i,
      /del\s+\/[fqs]\s+/i,
    ];

    return dangerous.some((pattern) => pattern.test(command));
  }

  private isDangerousPath(path: string): boolean {
    const dangerous = [
      /^\/etc\/(passwd|shadow|sudoers)/,
      /^\/boot\//,
      /^\/sys\//,
      /^\/proc\//,
      /^~\/.ssh\//,
      /^\/root\//,
      /^[A-Z]:\\Windows\\System32/i,
    ];

    return dangerous.some((pattern) => pattern.test(path));
  }

  /** Why the call may not run, or undefined when `onToolApproval` approved it. */
  private async requestApproval(
    tool: Tool,
    args: Record<string, unknown>,
    sideEffects: string[]
  ): Promise<string | undefined> {
    if (!this.config.onToolApproval) {
      return `Tool "${tool.name}" needs approval, and no approval handler is configured`;
    }
    const approved = await this.config.onToolApproval(tool.name, args, sideEffects);
    return approved ? undefined : 'User denied tool execution';
  }

  updateConstitution(_constitution: Constitution): void {}
}
