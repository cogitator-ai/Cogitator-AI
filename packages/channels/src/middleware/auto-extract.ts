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
  onError?: (error: Error) => void;
}

const ENTITY_TYPES: ReadonlySet<string> = new Set<EntityType>([
  'person',
  'organization',
  'location',
  'concept',
  'event',
  'object',
  'custom',
]);

const RELATION_TYPES: ReadonlySet<string> = new Set<RelationType>([
  'knows',
  'works_at',
  'located_in',
  'part_of',
  'related_to',
  'created_by',
  'belongs_to',
  'associated_with',
  'causes',
  'precedes',
  'custom',
]);

function toEntityType(type: string): EntityType {
  const normalized = type.toLowerCase();
  return ENTITY_TYPES.has(normalized) ? (normalized as EntityType) : 'custom';
}

function toRelationType(type: string): RelationType {
  const normalized = type.toLowerCase();
  return RELATION_TYPES.has(normalized) ? (normalized as RelationType) : 'custom';
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

    if (msg.text?.trim()) {
      void this.extractAndStore(msg.text).catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.config.onError) this.config.onError(error);
        else console.error('[auto-extract] Error:', error.message);
      });
    }
  }

  private async resolveNodeId(name: string, known: Map<string, string>): Promise<string | null> {
    const cached = known.get(name.toLowerCase());
    if (cached) return cached;
    const found = await this.config.graphAdapter.getNodeByName(this.config.agentId, name);
    if (!found.success || !found.data) return null;
    known.set(name.toLowerCase(), found.data.id);
    return found.data.id;
  }

  private async extractAndStore(text: string): Promise<void> {
    const { extractor, graphAdapter, agentId } = this.config;
    const result = await extractor.extract(text);
    const known = new Map<string, string>();

    for (const entity of result.entities) {
      const existing = await graphAdapter.getNodeByName(agentId, entity.name);
      if (existing.success && existing.data) {
        known.set(entity.name.toLowerCase(), existing.data.id);
        if (entity.confidence > existing.data.confidence) {
          await graphAdapter.updateNode(existing.data.id, {
            confidence: entity.confidence,
            ...(entity.description ? { description: entity.description } : {}),
          });
        }
        continue;
      }

      const rawType = entity.type;
      const type = toEntityType(rawType);
      const created = await graphAdapter.addNode({
        agentId,
        name: entity.name,
        type,
        description: entity.description,
        confidence: entity.confidence,
        source: 'extracted',
        aliases: [],
        properties: type === 'custom' && rawType ? { originalType: rawType } : {},
        metadata: {},
      });
      if (created.success && created.data) {
        known.set(entity.name.toLowerCase(), created.data.id);
      }
    }

    for (const relation of result.relations) {
      const sourceNodeId = await this.resolveNodeId(relation.from, known);
      const targetNodeId = await this.resolveNodeId(relation.to, known);
      if (!sourceNodeId || !targetNodeId) continue;

      const type = toRelationType(relation.type);
      const label = type === 'custom' ? relation.type : undefined;

      const between = await graphAdapter.getEdgesBetween(sourceNodeId, targetNodeId);
      const duplicate = between.success
        ? between.data.find((edge) => edge.type === type && edge.label === label)
        : undefined;

      if (duplicate) {
        if (relation.confidence > duplicate.confidence) {
          await graphAdapter.updateEdge(duplicate.id, { confidence: relation.confidence });
        }
        continue;
      }

      await graphAdapter.addEdge({
        agentId,
        sourceNodeId,
        targetNodeId,
        type,
        ...(label ? { label } : {}),
        confidence: relation.confidence,
        source: 'extracted',
        weight: 1.0,
        bidirectional: false,
        properties: {},
        metadata: {},
      });
    }

    if (this.config.coreFacts && this.config.coreFactPatterns) {
      for (const [key, pattern] of Object.entries(this.config.coreFactPatterns)) {
        pattern.lastIndex = 0;
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
