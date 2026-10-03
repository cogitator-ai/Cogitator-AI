import type {
  GraphAdapter,
  GraphNode,
  GraphEdge,
  GraphContext,
  GraphContextOptions,
  EmbeddingService,
  EntityType,
} from '@cogitator-ai/types';

export interface GraphContextBuilderConfig {
  maxNodes?: number;
  maxEdges?: number;
  maxDepth?: number;
  includeInferred?: boolean;
  tokensPerNode?: number;
  tokensPerEdge?: number;
}

const DEFAULT_CONFIG: Required<GraphContextBuilderConfig> = {
  maxNodes: 20,
  maxEdges: 50,
  maxDepth: 3,
  includeInferred: true,
  tokensPerNode: 30,
  tokensPerEdge: 15,
};

export class GraphContextBuilder {
  private graphAdapter: GraphAdapter;
  private embeddingService?: EmbeddingService;
  private config: Required<GraphContextBuilderConfig>;

  constructor(
    graphAdapter: GraphAdapter,
    embeddingService?: EmbeddingService,
    config: GraphContextBuilderConfig = {}
  ) {
    this.graphAdapter = graphAdapter;
    this.embeddingService = embeddingService;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async buildContext(
    agentId: string,
    input: string,
    options?: GraphContextOptions
  ): Promise<GraphContext> {
    const maxNodes = options?.maxNodes ?? this.config.maxNodes;
    const maxEdges = options?.maxEdges ?? this.config.maxEdges;
    const maxDepth = options?.maxDepth ?? this.config.maxDepth;
    const includeInferred = options?.includeInferred ?? this.config.includeInferred;
    const visible = (node: GraphNode) => {
      const owner = node.metadata?.userId;
      return owner === undefined || owner === null || owner === options?.userId;
    };

    const relevantNodes: GraphNode[] = [];
    const relevantEdges: GraphEdge[] = [];
    const seenNodeIds = new Set<string>();
    const seenEdgeIds = new Set<string>();

    if (this.embeddingService) {
      const vector = await this.embeddingService.embed(input);
      const semanticResults = await this.graphAdapter.searchNodesSemantic({
        agentId,
        vector,
        limit: Math.min(5, maxNodes),
        threshold: 0.6,
        entityTypes: options?.entityTypes,
      });

      if (semanticResults.success) {
        for (const node of semanticResults.data.filter(visible)) {
          if (!seenNodeIds.has(node.id)) {
            relevantNodes.push(node);
            seenNodeIds.add(node.id);
          }
        }
      }
    }

    const keywords = this.extractKeywords(input);
    for (const keyword of keywords) {
      if (relevantNodes.length >= maxNodes) break;

      const nodesResult = await this.graphAdapter.queryNodes({
        agentId,
        namePattern: keyword,
        limit: 3,
      });

      if (nodesResult.success) {
        for (const node of nodesResult.data.filter(visible)) {
          if (!seenNodeIds.has(node.id) && relevantNodes.length < maxNodes) {
            relevantNodes.push(node);
            seenNodeIds.add(node.id);
          }
        }
      }
    }

    for (const seedNode of [...relevantNodes]) {
      if (relevantNodes.length >= maxNodes) break;

      const traversalResult = await this.graphAdapter.traverse({
        agentId,
        startNodeId: seedNode.id,
        maxDepth,
        direction: 'both',
        limit: maxNodes - relevantNodes.length,
      });

      if (traversalResult.success) {
        for (const node of traversalResult.data.visitedNodes.filter(visible)) {
          if (!seenNodeIds.has(node.id) && relevantNodes.length < maxNodes) {
            relevantNodes.push(node);
            seenNodeIds.add(node.id);
          }
        }

        for (const edge of traversalResult.data.visitedEdges) {
          if (!seenEdgeIds.has(edge.id) && relevantEdges.length < maxEdges) {
            if (!includeInferred && edge.source === 'inferred') continue;
            relevantEdges.push(edge);
            seenEdgeIds.add(edge.id);
          }
        }
      }
    }

    const rankedNodes = this.rankNodes(relevantNodes, input);
    const finalNodes = rankedNodes.slice(0, maxNodes);

    const finalNodeIds = new Set(finalNodes.map((n) => n.id));
    const finalEdges = relevantEdges
      .filter((e) => finalNodeIds.has(e.sourceNodeId) && finalNodeIds.has(e.targetNodeId))
      .slice(0, maxEdges);

    const formattedContext = this.formatContext(finalNodes, finalEdges);
    const tokenCount = this.estimateTokens(finalNodes, finalEdges);

    return {
      nodes: finalNodes,
      edges: finalEdges,
      formattedContext,
      tokenCount,
    };
  }

  private extractKeywords(input: string): string[] {
    const stopWords = new Set([
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'must',
      'shall',
      'can',
      'need',
      'dare',
      'ought',
      'used',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'as',
      'into',
      'through',
      'during',
      'before',
      'after',
      'above',
      'below',
      'between',
      'under',
      'again',
      'further',
      'then',
      'once',
      'here',
      'there',
      'when',
      'where',
      'why',
      'how',
      'all',
      'each',
      'few',
      'more',
      'most',
      'other',
      'some',
      'such',
      'no',
      'nor',
      'not',
      'only',
      'own',
      'same',
      'so',
      'than',
      'too',
      'very',
      'just',
      'and',
      'but',
      'if',
      'or',
      'because',
      'while',
      'although',
      'however',
      'either',
      'neither',
      'both',
      'what',
      'which',
      'who',
      'whom',
      'this',
      'that',
      'these',
      'those',
      'i',
      'me',
      'my',
      'myself',
      'we',
      'our',
      'ours',
      'ourselves',
      'you',
      'your',
      'yours',
      'yourself',
      'yourselves',
      'he',
      'him',
      'his',
      'himself',
      'she',
      'her',
      'hers',
      'herself',
      'it',
      'its',
      'itself',
      'they',
      'them',
      'their',
      'theirs',
      'themselves',
      'about',
      'know',
      'tell',
      'say',
      'said',
    ]);

    const words = input
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopWords.has(word));

    const uniqueWords = [...new Set(words)];

    return uniqueWords.slice(0, 10);
  }

  private rankNodes(nodes: GraphNode[], input: string): GraphNode[] {
    const inputLower = input.toLowerCase();
    const keywords = this.extractKeywords(input);

    return nodes
      .map((node) => {
        let score = 0;

        if (inputLower.includes(node.name.toLowerCase())) {
          score += 10;
        }

        for (const alias of node.aliases) {
          if (inputLower.includes(alias.toLowerCase())) {
            score += 5;
          }
        }

        for (const keyword of keywords) {
          if (node.name.toLowerCase().includes(keyword)) {
            score += 3;
          }
          if (node.description?.toLowerCase().includes(keyword)) {
            score += 1;
          }
        }

        score += node.accessCount * 0.1;

        score += node.confidence * 2;

        return { node, score };
      })
      .sort((a, b) => b.score - a.score)
      .map(({ node }) => node);
  }

  private formatContext(nodes: GraphNode[], edges: GraphEdge[]): string {
    if (nodes.length === 0) return '';

    const lines: string[] = ['## Knowledge Graph Context', ''];

    lines.push('### Entities');
    for (const node of nodes) {
      const typeLabel = this.formatEntityType(node.type);
      let line = `- **${node.name}** (${typeLabel})`;

      if (node.description) {
        line += `: ${node.description}`;
      }

      if (node.aliases.length > 0) {
        line += ` [aka: ${node.aliases.join(', ')}]`;
      }

      lines.push(line);
    }

    if (edges.length > 0) {
      lines.push('');
      lines.push('### Relationships');

      const nodeNameMap = new Map(nodes.map((n) => [n.id, n.name]));

      for (const edge of edges) {
        const sourceName = nodeNameMap.get(edge.sourceNodeId) ?? edge.sourceNodeId;
        const targetName = nodeNameMap.get(edge.targetNodeId) ?? edge.targetNodeId;
        const relLabel = edge.label ?? this.formatRelationType(edge.type);

        let line = `- ${sourceName} → ${relLabel} → ${targetName}`;

        if (edge.bidirectional) {
          line = `- ${sourceName} ↔ ${relLabel} ↔ ${targetName}`;
        }

        lines.push(line);
      }
    }

    return lines.join('\n');
  }

  private formatEntityType(type: EntityType): string {
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  private formatRelationType(type: string): string {
    return type.replace(/_/g, ' ');
  }

  private estimateTokens(nodes: GraphNode[], edges: GraphEdge[]): number {
    return nodes.length * this.config.tokensPerNode + edges.length * this.config.tokensPerEdge;
  }
}
