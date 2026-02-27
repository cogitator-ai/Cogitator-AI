import type {
  GatewayMiddleware,
  ChannelMessage,
  MiddlewareContext,
  GraphAdapter,
  EntityType,
  RelationType,
} from '@cogitator-ai/types';

export interface ExtractedEntities {
  entities: Array<{
    name: string;
    type: string;
    confidence: number;
    description?: string;
  }>;
  relations: Array<{
    from: string;
    to: string;
    type: string;
    confidence: number;
  }>;
}

export interface EntityExtractor {
  extract(text: string, context?: string): Promise<ExtractedEntities>;
}

export interface AutoExtractConfig {
  extractor: EntityExtractor;
  graphAdapter: GraphAdapter;
  agentId: string;
  coreFacts?: { set(key: string, value: string): Promise<void> };
  coreFactPatterns?: Record<string, RegExp>;
}

export class AutoExtractMiddleware implements GatewayMiddleware {
  readonly name = 'auto-extract';

  constructor(private config: AutoExtractConfig) {}

  async handle(
    msg: ChannelMessage,
    _ctx: MiddlewareContext,
    next: () => Promise<void>
  ): Promise<void> {
    await next();

    if (msg.text) {
      void this.extractAndStore(msg.text).catch((err) => {
        console.error('[auto-extract] Error:', err);
      });
    }
  }

  private async extractAndStore(text: string): Promise<void> {
    const { extractor, graphAdapter, agentId } = this.config;
    const result = await extractor.extract(text);

    for (const entity of result.entities) {
      const existing = await graphAdapter.getNodeByName(agentId, entity.name);
      if (existing.success && existing.data) {
        if (entity.confidence > existing.data.confidence) {
          await graphAdapter.updateNode(existing.data.id, {
            confidence: entity.confidence,
            description: entity.description,
          });
        }
      } else {
        await graphAdapter.addNode({
          agentId,
          name: entity.name,
          type: entity.type as EntityType,
          description: entity.description,
          confidence: entity.confidence,
          source: 'extracted',
          aliases: [],
          properties: {},
          metadata: {},
        });
      }
    }

    for (const relation of result.relations) {
      const fromNode = await graphAdapter.getNodeByName(agentId, relation.from);
      const toNode = await graphAdapter.getNodeByName(agentId, relation.to);
      if (fromNode.success && fromNode.data && toNode.success && toNode.data) {
        await graphAdapter.addEdge({
          agentId,
          sourceNodeId: fromNode.data.id,
          targetNodeId: toNode.data.id,
          type: relation.type as RelationType,
          confidence: relation.confidence,
          source: 'extracted',
          weight: 1.0,
          bidirectional: false,
          properties: {},
          metadata: {},
        });
      }
    }

    if (this.config.coreFacts && this.config.coreFactPatterns) {
      for (const [key, pattern] of Object.entries(this.config.coreFactPatterns)) {
        const match = pattern.exec(text);
        if (match?.[1]) {
          await this.config.coreFacts.set(key, match[1].trim());
        }
      }
    }
  }
}

export function autoExtract(config: AutoExtractConfig): GatewayMiddleware {
  return new AutoExtractMiddleware(config);
}
