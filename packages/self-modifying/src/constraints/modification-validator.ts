import type {
  ModificationRequest,
  ModificationValidationResult,
  ModificationConstraints,
  ConstraintCheckResult,
  SafetyConstraint,
  CapabilityConstraint,
  ResourceConstraint,
  CustomConstraint,
  ConstraintRule,
} from '@cogitator-ai/types';
import { createDefaultConstraints, mergeConstraints } from './safety-constraints';

export interface ModificationValidatorOptions {
  constraints?: Partial<ModificationConstraints>;
  strictMode?: boolean;
}

export class ModificationValidator {
  private constraints: ModificationConstraints;
  private strictMode: boolean;

  constructor(options: ModificationValidatorOptions = {}) {
    this.constraints = mergeConstraints(createDefaultConstraints(), options.constraints ?? {});
    this.strictMode = options.strictMode ?? false;
  }

  async validate(request: ModificationRequest): Promise<ModificationValidationResult> {
    const results: ConstraintCheckResult[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    const safetyResults = await this.checkSafetyConstraints(request);
    results.push(...safetyResults);

    const capabilityResults = await this.checkCapabilityConstraints(request);
    results.push(...capabilityResults);

    const resourceResults = await this.checkResourceConstraints(request);
    results.push(...resourceResults);

    const customResults = await this.checkCustomConstraints(request);
    results.push(...customResults);

    for (const result of results) {
      if (!result.satisfied) {
        if (result.severity === 'critical' || result.severity === 'error') {
          errors.push(result.message ?? `Constraint ${result.constraintName} violated`);
        } else {
          warnings.push(result.message ?? `Constraint ${result.constraintName} warning`);
        }
      }
    }

    const hasCriticalViolation = results.some((r) => !r.satisfied && r.severity === 'critical');
    const hasErrorViolation = results.some((r) => !r.satisfied && r.severity === 'error');

    const valid = this.strictMode
      ? results.every((r) => r.satisfied)
      : !hasCriticalViolation && !hasErrorViolation;

    return {
      valid,
      constraintResults: results,
      errors,
      warnings,
      rollbackRequired: hasCriticalViolation,
    };
  }

  private async checkSafetyConstraints(
    request: ModificationRequest
  ): Promise<ConstraintCheckResult[]> {
    const results: ConstraintCheckResult[] = [];

    for (const constraint of this.constraints.safety) {
      const satisfied = this.evaluateSafetyRule(constraint.rule, request);
      results.push({
        constraintId: constraint.id,
        constraintName: constraint.name,
        satisfied,
        severity: constraint.severity,
        message: satisfied ? undefined : constraint.description,
      });
    }

    return results;
  }

  private evaluateSafetyRule(rule: ConstraintRule, request: ModificationRequest): boolean {
    if (typeof rule === 'string') {
      return this.evaluateExpression(rule, request.payload as Record<string, unknown>);
    }

    const payload = request.payload as Record<string, unknown>;

    switch (rule.type) {
      case 'invariant':
        return this.evaluateExpression(rule.expression ?? '', payload);
      case 'precondition':
        return this.evaluateExpression(rule.expression ?? '', payload);
      case 'postcondition':
        return true;
      case 'temporal':
        if (rule.pattern?.source === 'never') {
          return !this.evaluateExpression(rule.expression ?? '', payload);
        }
        return true;
      default:
        return true;
    }
  }

  private evaluateExpression(expression: string, context: Record<string, unknown>): boolean {
    const parts = expression.split(/\s+(AND|OR)\s+/i);
    const conditions: boolean[] = [];
    const operators: string[] = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (part.toUpperCase() === 'AND' || part.toUpperCase() === 'OR') {
        operators.push(part.toUpperCase());
      } else {
        conditions.push(this.evaluateSimpleCondition(part, context));
      }
    }

    if (conditions.length === 0) return true;

    let result = conditions[0];
    for (let i = 0; i < operators.length; i++) {
      if (operators[i] === 'AND') {
        result = result && conditions[i + 1];
      } else {
        result = result || conditions[i + 1];
      }
    }

    return result;
  }

  private evaluateSimpleCondition(condition: string, context: Record<string, unknown>): boolean {
    const operators = ['<=', '>=', '<', '>', '!=', '='];
    for (const op of operators) {
      const idx = condition.indexOf(op);
      if (idx !== -1) {
        const left = condition.substring(0, idx).trim();
        const right = condition.substring(idx + op.length).trim();
        const leftValue = this.resolveValue(left, context);
        const rightValue = this.resolveValue(right, context);

        switch (op) {
          case '=':
            return leftValue === rightValue;
          case '!=':
            return leftValue !== rightValue;
          case '<':
            return Number(leftValue) < Number(rightValue);
          case '>':
            return Number(leftValue) > Number(rightValue);
          case '<=':
            return Number(leftValue) <= Number(rightValue);
          case '>=':
            return Number(leftValue) >= Number(rightValue);
        }
      }
    }

    const value = this.resolveValue(condition, context);
    return Boolean(value);
  }

  private resolveValue(expr: string, context: Record<string, unknown>): unknown {
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (/^\d+(\.\d+)?$/.test(expr)) return parseFloat(expr);

    const keys = expr.split('.');
    let current: unknown = context;
    for (const key of keys) {
      if (current && typeof current === 'object') {
        current = (current as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }
    return current;
  }

  private async checkCapabilityConstraints(
    request: ModificationRequest
  ): Promise<ConstraintCheckResult[]> {
    const results: ConstraintCheckResult[] = [];

    if (request.type !== 'tool_generation') {
      return results;
    }

    const payload = request.payload as { category?: string; complexity?: number };

    for (const constraint of this.constraints.capability) {
      let satisfied = true;
      let message: string | undefined;

      if (payload.category) {
        if (constraint.forbidden?.includes(payload.category)) {
          satisfied = false;
          message = `Category '${payload.category}' is forbidden`;
        } else if (constraint.allowed?.length && !constraint.allowed.includes(payload.category)) {
          satisfied = false;
          message = `Category '${payload.category}' is not in allowed list`;
        }
      }

      if (
        satisfied &&
        constraint.maxComplexity &&
        payload.complexity &&
        payload.complexity > constraint.maxComplexity
      ) {
        satisfied = false;
        message = `Complexity ${payload.complexity} exceeds max ${constraint.maxComplexity}`;
      }

      results.push({
        constraintId: constraint.id,
        constraintName: constraint.name,
        satisfied,
        severity: 'error',
        message,
      });
    }

    return results;
  }

  private async checkResourceConstraints(
    request: ModificationRequest
  ): Promise<ConstraintCheckResult[]> {
    const results: ConstraintCheckResult[] = [];
    const payload = request.payload as {
      tokensUsed?: number;
      cost?: number;
      activeTools?: number;
    };

    for (const constraint of this.constraints.resource) {
      let satisfied = true;
      let message: string | undefined;

      if (
        constraint.maxTokensPerRun &&
        payload.tokensUsed &&
        payload.tokensUsed > constraint.maxTokensPerRun
      ) {
        satisfied = false;
        message = `Tokens ${payload.tokensUsed} exceeds max ${constraint.maxTokensPerRun}`;
      }

      if (
        satisfied &&
        constraint.maxCostPerRun &&
        payload.cost &&
        payload.cost > constraint.maxCostPerRun
      ) {
        satisfied = false;
        message = `Cost ${payload.cost} exceeds max ${constraint.maxCostPerRun}`;
      }

      if (
        satisfied &&
        constraint.maxToolsActive &&
        payload.activeTools &&
        payload.activeTools > constraint.maxToolsActive
      ) {
        satisfied = false;
        message = `Active tools ${payload.activeTools} exceeds max ${constraint.maxToolsActive}`;
      }

      results.push({
        constraintId: constraint.id,
        constraintName: constraint.name,
        satisfied,
        severity: 'error',
        message,
      });
    }

    return results;
  }

  private async checkCustomConstraints(
    request: ModificationRequest
  ): Promise<ConstraintCheckResult[]> {
    const results: ConstraintCheckResult[] = [];

    for (const constraint of this.constraints.custom ?? []) {
      let satisfied: boolean;
      try {
        satisfied = await constraint.predicate(request);
      } catch {
        satisfied = false;
      }

      results.push({
        constraintId: constraint.id,
        constraintName: constraint.name,
        satisfied,
        severity: 'error',
        message: satisfied ? undefined : constraint.description,
      });
    }

    return results;
  }

  addSafetyConstraint(constraint: SafetyConstraint): void {
    const idx = this.constraints.safety.findIndex((c) => c.id === constraint.id);
    if (idx >= 0) {
      this.constraints.safety[idx] = constraint;
    } else {
      this.constraints.safety.push(constraint);
    }
  }

  addCapabilityConstraint(constraint: CapabilityConstraint): void {
    const idx = this.constraints.capability.findIndex((c) => c.id === constraint.id);
    if (idx >= 0) {
      this.constraints.capability[idx] = constraint;
    } else {
      this.constraints.capability.push(constraint);
    }
  }

  addResourceConstraint(constraint: ResourceConstraint): void {
    const idx = this.constraints.resource.findIndex((c) => c.id === constraint.id);
    if (idx >= 0) {
      this.constraints.resource[idx] = constraint;
    } else {
      this.constraints.resource.push(constraint);
    }
  }

  addCustomConstraint(constraint: CustomConstraint): void {
    if (!this.constraints.custom) {
      this.constraints.custom = [];
    }
    const idx = this.constraints.custom.findIndex((c) => c.id === constraint.id);
    if (idx >= 0) {
      this.constraints.custom[idx] = constraint;
    } else {
      this.constraints.custom.push(constraint);
    }
  }

  removeConstraint(id: string): boolean {
    const safetyIdx = this.constraints.safety.findIndex((c) => c.id === id);
    if (safetyIdx >= 0) {
      this.constraints.safety.splice(safetyIdx, 1);
      return true;
    }

    const capIdx = this.constraints.capability.findIndex((c) => c.id === id);
    if (capIdx >= 0) {
      this.constraints.capability.splice(capIdx, 1);
      return true;
    }

    const resIdx = this.constraints.resource.findIndex((c) => c.id === id);
    if (resIdx >= 0) {
      this.constraints.resource.splice(resIdx, 1);
      return true;
    }

    if (this.constraints.custom) {
      const customIdx = this.constraints.custom.findIndex((c) => c.id === id);
      if (customIdx >= 0) {
        this.constraints.custom.splice(customIdx, 1);
        return true;
      }
    }

    return false;
  }

  getConstraints(): ModificationConstraints {
    return { ...this.constraints };
  }
}
