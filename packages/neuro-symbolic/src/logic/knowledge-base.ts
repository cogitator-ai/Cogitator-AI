import type { Clause, CompoundTerm, Term, KnowledgeBaseStats } from '@cogitator-ai/types';
import { parseProgram, parseClause } from './parser';
import { termToString } from './unification';

export interface KnowledgeBaseOptions {
  allowDuplicates?: boolean;
}

export class KnowledgeBase {
  private clauses = new Map<string, Clause[]>();
  private factCount = 0;
  private ruleCount = 0;
  private options: Required<KnowledgeBaseOptions>;

  constructor(options: KnowledgeBaseOptions = {}) {
    this.options = {
      allowDuplicates: options.allowDuplicates ?? false,
    };
  }

  private getKey(functor: string, arity: number): string {
    return `${functor}/${arity}`;
  }

  private addClause(clause: Clause): void {
    const key = this.getKey(clause.head.functor, clause.head.args.length);
    const existing = this.clauses.get(key) || [];

    if (!this.options.allowDuplicates) {
      const duplicate = existing.find((c) => this.clausesEqual(c, clause));
      if (duplicate) return;
    }

    existing.push(clause);
    this.clauses.set(key, existing);

    if (clause.body.length === 0) {
      this.factCount++;
    } else {
      this.ruleCount++;
    }
  }

  private clausesEqual(c1: Clause, c2: Clause): boolean {
    return (
      termToString(c1.head) === termToString(c2.head) &&
      c1.body.length === c2.body.length &&
      c1.body.every((g, i) => termToString(g) === termToString(c2.body[i]))
    );
  }

  assertFact(predicate: string, args: Term[]): void {
    const clause: Clause = {
      head: { type: 'compound', functor: predicate, args },
      body: [],
    };
    this.addClause(clause);
  }

  assertRule(head: CompoundTerm, body: CompoundTerm[]): void {
    const clause: Clause = { head, body };
    this.addClause(clause);
  }

  assert(clauseString: string): boolean {
    const result = parseClause(clauseString);
    if (!result.success || !result.value) {
      return false;
    }
    this.addClause(result.value);
    return true;
  }

  consult(program: string): { success: boolean; errors: string[] } {
    const result = parseProgram(program);
    if (!result.success || !result.value) {
      return {
        success: false,
        errors: [result.error?.message || 'Parse error'],
      };
    }

    for (const clause of result.value) {
      this.addClause(clause);
    }

    return { success: true, errors: [] };
  }

  getClauses(predicate: string, arity: number): Clause[] {
    const key = this.getKey(predicate, arity);
    return this.clauses.get(key) || [];
  }

  getAllClauses(): Clause[] {
    const all: Clause[] = [];
    for (const clauses of this.clauses.values()) {
      all.push(...clauses);
    }
    return all;
  }

  getPredicates(): string[] {
    return Array.from(this.clauses.keys());
  }

  hasPredicate(predicate: string, arity: number): boolean {
    const key = this.getKey(predicate, arity);
    return this.clauses.has(key) && (this.clauses.get(key)?.length || 0) > 0;
  }

  retract(clause: Clause): boolean {
    const key = this.getKey(clause.head.functor, clause.head.args.length);
    const existing = this.clauses.get(key);
    if (!existing) return false;

    const index = existing.findIndex((c) => this.clausesEqual(c, clause));
    if (index === -1) return false;

    const removed = existing.splice(index, 1)[0];
    if (removed.body.length === 0) {
      this.factCount--;
    } else {
      this.ruleCount--;
    }

    return true;
  }

  retractAll(predicate: string, arity: number): number {
    const key = this.getKey(predicate, arity);
    const existing = this.clauses.get(key);
    if (!existing) return 0;

    const count = existing.length;
    for (const clause of existing) {
      if (clause.body.length === 0) {
        this.factCount--;
      } else {
        this.ruleCount--;
      }
    }

    this.clauses.delete(key);
    return count;
  }

  abolish(predicate: string, arity: number): void {
    this.retractAll(predicate, arity);
  }

  clear(): void {
    this.clauses.clear();
    this.factCount = 0;
    this.ruleCount = 0;
  }

  getStats(): KnowledgeBaseStats {
    const predicates = this.getPredicates();
    let totalBodyLength = 0;
    let ruleCount = 0;

    for (const clauses of this.clauses.values()) {
      for (const clause of clauses) {
        if (clause.body.length > 0) {
          ruleCount++;
          totalBodyLength += clause.body.length;
        }
      }
    }

    return {
      factCount: this.factCount,
      ruleCount: this.ruleCount,
      predicates,
      avgRuleBodyLength: ruleCount > 0 ? totalBodyLength / ruleCount : 0,
    };
  }

  toString(): string {
    const lines: string[] = [];

    for (const clauses of this.clauses.values()) {
      for (const clause of clauses) {
        lines.push(this.clauseToString(clause));
      }
    }

    return lines.join('\n');
  }

  private clauseToString(clause: Clause): string {
    const head = termToString(clause.head);
    if (clause.body.length === 0) {
      return `${head}.`;
    }
    const body = clause.body.map(termToString).join(', ');
    return `${head} :- ${body}.`;
  }

  clone(): KnowledgeBase {
    const kb = new KnowledgeBase(this.options);
    for (const [key, clauses] of this.clauses) {
      kb.clauses.set(
        key,
        clauses.map((c) => ({
          head: structuredClone(c.head),
          body: c.body.map((g) => structuredClone(g)),
          metadata: c.metadata ? structuredClone(c.metadata) : undefined,
        }))
      );
    }
    kb.factCount = this.factCount;
    kb.ruleCount = this.ruleCount;
    return kb;
  }

  merge(other: KnowledgeBase): void {
    for (const clauses of other.clauses.values()) {
      for (const clause of clauses) {
        this.addClause(clause);
      }
    }
  }

  export(): string {
    return JSON.stringify({
      clauses: this.getAllClauses(),
      factCount: this.factCount,
      ruleCount: this.ruleCount,
    });
  }

  static import(json: string, options?: KnowledgeBaseOptions): KnowledgeBase {
    const data = JSON.parse(json) as {
      clauses: Clause[];
      factCount: number;
      ruleCount: number;
    };

    const kb = new KnowledgeBase(options);
    for (const clause of data.clauses) {
      kb.addClause(clause);
    }
    return kb;
  }
}

export function createKnowledgeBase(program?: string): KnowledgeBase {
  const kb = new KnowledgeBase();
  if (program) {
    kb.consult(program);
  }
  return kb;
}
