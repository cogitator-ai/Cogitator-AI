import type { ProofNode, ProofTree, Term, Substitution } from '@cogitator-ai/types';
import { termToString, applySubstitution } from './unification';

export interface ProofTreeOptions {
  maxDepth?: number;
  showSubstitutions?: boolean;
  showClauseUsed?: boolean;
  collapseFailures?: boolean;
  indent?: string;
}

const defaultOptions: Required<ProofTreeOptions> = {
  maxDepth: Infinity,
  showSubstitutions: true,
  showClauseUsed: true,
  collapseFailures: false,
  indent: '  ',
};

export function formatProofTree(tree: ProofTree, options: ProofTreeOptions = {}): string {
  const opts = { ...defaultOptions, ...options };
  const lines: string[] = [];

  lines.push('╔════════════════════════════════════════════════════════════════╗');
  lines.push('║                        PROOF TREE                              ║');
  lines.push('╠════════════════════════════════════════════════════════════════╣');
  lines.push(`║ Solutions: ${tree.solutions.length}`.padEnd(67) + '║');
  lines.push(`║ Explored nodes: ${tree.exploredNodes}`.padEnd(67) + '║');
  lines.push(`║ Max depth: ${tree.maxDepth}`.padEnd(67) + '║');
  lines.push(`║ Duration: ${tree.duration}ms`.padEnd(67) + '║');
  lines.push('╚════════════════════════════════════════════════════════════════╝');
  lines.push('');

  formatNode(tree.root, 0, '', true, lines, opts);

  return lines.join('\n');
}

function formatNode(
  node: ProofNode,
  depth: number,
  prefix: string,
  isLast: boolean,
  lines: string[],
  opts: Required<ProofTreeOptions>
): void {
  if (depth > opts.maxDepth) {
    return;
  }

  if (opts.collapseFailures && node.status === 'failure' && node.children.length === 0) {
    return;
  }

  const statusIcon = getStatusIcon(node.status);
  const connector = depth === 0 ? '' : isLast ? '└── ' : '├── ';
  const goalStr = termToString(node.goal);

  let line = `${prefix}${connector}${statusIcon} ${goalStr}`;

  if (opts.showSubstitutions && node.substitution.size > 0) {
    const relevantBindings = getRelevantBindings(node);
    if (relevantBindings.length > 0) {
      line += ` {${relevantBindings.join(', ')}}`;
    }
  }

  if (opts.showClauseUsed && node.clause) {
    const clauseHead = termToString(node.clause.head);
    if (node.clause.body.length > 0) {
      const clauseBody = node.clause.body.map(termToString).join(', ');
      line += ` ← ${clauseHead} :- ${clauseBody}`;
    } else {
      line += ` ← ${clauseHead}`;
    }
  }

  lines.push(line);

  const childPrefix = prefix + (depth === 0 ? '' : isLast ? '    ' : '│   ');

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const isLastChild = i === node.children.length - 1;
    formatNode(child, depth + 1, childPrefix, isLastChild, lines, opts);
  }
}

function getStatusIcon(status: ProofNode['status']): string {
  switch (status) {
    case 'success':
      return '✓';
    case 'failure':
      return '✗';
    case 'pending':
      return '○';
    case 'cut':
      return '!';
    default:
      return '?';
  }
}

function getRelevantBindings(node: ProofNode): string[] {
  const bindings: string[] = [];

  for (const [varName, term] of node.substitution) {
    if (!varName.startsWith('_')) {
      bindings.push(`${varName}=${termToString(term)}`);
    }
  }

  return bindings;
}

export interface ProofPath {
  nodes: ProofNode[];
  bindings: Substitution;
}

export function extractProofPaths(tree: ProofTree): ProofPath[] {
  const paths: ProofPath[] = [];

  function traverse(node: ProofNode, currentPath: ProofNode[]): void {
    currentPath.push(node);

    if (node.status === 'success' && node.children.length === 0) {
      paths.push({
        nodes: [...currentPath],
        bindings: node.substitution,
      });
    }

    for (const child of node.children) {
      if (child.status === 'success' || child.status === 'cut') {
        traverse(child, currentPath);
      }
    }

    currentPath.pop();
  }

  traverse(tree.root, []);
  return paths;
}

export function formatProofPath(path: ProofPath, template?: Term): string {
  const lines: string[] = [];

  lines.push('Proof path:');

  for (let i = 0; i < path.nodes.length; i++) {
    const node = path.nodes[i];
    const indent = '  '.repeat(i);
    const goalStr = termToString(node.goal);

    if (node.clause) {
      const clauseStr =
        node.clause.body.length > 0
          ? `${termToString(node.clause.head)} :- ${node.clause.body.map(termToString).join(', ')}`
          : termToString(node.clause.head);
      lines.push(`${indent}${goalStr} [using: ${clauseStr}]`);
    } else {
      lines.push(`${indent}${goalStr}`);
    }
  }

  if (path.bindings.size > 0) {
    lines.push('');
    lines.push('Bindings:');
    for (const [varName, term] of path.bindings) {
      if (!varName.startsWith('_')) {
        lines.push(`  ${varName} = ${termToString(term)}`);
      }
    }
  }

  if (template) {
    lines.push('');
    const result = applySubstitution(template, path.bindings);
    lines.push(`Result: ${termToString(result)}`);
  }

  return lines.join('\n');
}

export interface ProofStats {
  totalNodes: number;
  successNodes: number;
  failureNodes: number;
  cutNodes: number;
  maxBranchingFactor: number;
  avgBranchingFactor: number;
  leafNodes: number;
  uniquePredicates: Set<string>;
}

export function analyzeProofTree(tree: ProofTree): ProofStats {
  const stats: ProofStats = {
    totalNodes: 0,
    successNodes: 0,
    failureNodes: 0,
    cutNodes: 0,
    maxBranchingFactor: 0,
    avgBranchingFactor: 0,
    leafNodes: 0,
    uniquePredicates: new Set(),
  };

  let totalBranching = 0;
  let internalNodes = 0;

  function traverse(node: ProofNode): void {
    stats.totalNodes++;

    if (node.goal.functor) {
      stats.uniquePredicates.add(`${node.goal.functor}/${node.goal.args.length}`);
    }

    switch (node.status) {
      case 'success':
        stats.successNodes++;
        break;
      case 'failure':
        stats.failureNodes++;
        break;
      case 'cut':
        stats.cutNodes++;
        break;
    }

    if (node.children.length === 0) {
      stats.leafNodes++;
    } else {
      internalNodes++;
      totalBranching += node.children.length;

      if (node.children.length > stats.maxBranchingFactor) {
        stats.maxBranchingFactor = node.children.length;
      }
    }

    for (const child of node.children) {
      traverse(child);
    }
  }

  traverse(tree.root);

  stats.avgBranchingFactor = internalNodes > 0 ? totalBranching / internalNodes : 0;

  return stats;
}

export function pruneProofTree(tree: ProofTree, keepSuccessOnly: boolean = true): ProofTree {
  function pruneNode(node: ProofNode): ProofNode | null {
    if (keepSuccessOnly && node.status === 'failure') {
      return null;
    }

    const prunedChildren: ProofNode[] = [];
    for (const child of node.children) {
      const pruned = pruneNode(child);
      if (pruned) {
        prunedChildren.push(pruned);
      }
    }

    return {
      ...node,
      children: prunedChildren,
    };
  }

  const prunedRoot = pruneNode(tree.root);

  return {
    root: prunedRoot || tree.root,
    solutions: tree.solutions,
    exploredNodes: tree.exploredNodes,
    maxDepth: tree.maxDepth,
    duration: tree.duration,
  };
}

export function proofTreeToMermaid(tree: ProofTree): string {
  const lines: string[] = ['graph TD'];
  let nodeCounter = 0;
  const nodeIds = new Map<ProofNode, string>();

  function getNodeId(node: ProofNode): string {
    if (!nodeIds.has(node)) {
      nodeIds.set(node, `N${nodeCounter++}`);
    }
    return nodeIds.get(node)!;
  }

  function traverse(node: ProofNode): void {
    const id = getNodeId(node);
    const label = escapeLabel(termToString(node.goal));
    const style = getNodeStyle(node.status);

    lines.push(`    ${id}["${label}"]${style}`);

    for (const child of node.children) {
      const childId = getNodeId(child);
      traverse(child);
      lines.push(`    ${id} --> ${childId}`);
    }
  }

  traverse(tree.root);

  return lines.join('\n');
}

function escapeLabel(str: string): string {
  return str
    .replace(/"/g, "'")
    .replace(/\n/g, ' ')
    .replace(/[[\]{}()<>|#]/g, (c) => `#${c.charCodeAt(0)};`);
}

function getNodeStyle(status: ProofNode['status']): string {
  switch (status) {
    case 'success':
      return ':::success';
    case 'failure':
      return ':::failure';
    case 'cut':
      return ':::cut';
    default:
      return '';
  }
}

export function proofTreeToJSON(tree: ProofTree): object {
  function nodeToJSON(node: ProofNode): object {
    return {
      id: node.id,
      goal: termToString(node.goal),
      status: node.status,
      depth: node.depth,
      clause: node.clause
        ? {
            head: termToString(node.clause.head),
            body: node.clause.body.map(termToString),
          }
        : null,
      children: node.children.map(nodeToJSON),
    };
  }

  return {
    root: nodeToJSON(tree.root),
    solutions: tree.solutions.map((s) => {
      const obj: Record<string, string> = {};
      for (const [k, v] of s) {
        if (!k.startsWith('_')) {
          obj[k] = termToString(v);
        }
      }
      return obj;
    }),
    stats: {
      exploredNodes: tree.exploredNodes,
      maxDepth: tree.maxDepth,
      duration: tree.duration,
    },
  };
}
