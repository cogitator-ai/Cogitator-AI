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

  async evaluate(
    tool: Tool,
    args: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolGuardResult> {
    const sideEffects = tool.sideEffects ?? [];
    const requiresApproval = this.checkApproval(tool, args);
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

    if (this.config.strictMode && sideEffects.length > 0) {
      const approved = await this.requestApproval(tool, args, sideEffects);
      return {
        approved,
        requiresConfirmation: true,
        sideEffects,
        riskLevel,
        reason: approved ? undefined : 'User denied tool execution',
      };
    }

    if (requiresApproval) {
      const approved = await this.requestApproval(tool, args, sideEffects);
      return {
        approved,
        requiresConfirmation: true,
        sideEffects,
        riskLevel,
        reason: approved ? undefined : 'User denied tool execution',
      };
    }

    return {
      approved: true,
      requiresConfirmation: false,
      sideEffects,
      riskLevel,
    };
  }

  private checkApproval(tool: Tool, args: Record<string, unknown>): boolean {
    if (typeof tool.requiresApproval === 'function') {
      return tool.requiresApproval(args);
    }
    return tool.requiresApproval ?? false;
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

  private async requestApproval(
    tool: Tool,
    args: Record<string, unknown>,
    sideEffects: string[]
  ): Promise<boolean> {
    if (this.config.onToolApproval) {
      return this.config.onToolApproval(tool.name, args, sideEffects);
    }
    return true;
  }

  updateConstitution(_constitution: Constitution): void {}
}
