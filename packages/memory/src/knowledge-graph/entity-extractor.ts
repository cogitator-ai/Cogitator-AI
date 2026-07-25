import type {
  EntityExtractor,
  ExtractionResult,
  ExtractionContext,
  ExtractedEntity,
  ExtractedRelation,
  EntityType,
  RelationType,
} from '@cogitator-ai/types';
import { z } from 'zod';
import { ExtractedEntitySchema, ExtractedRelationSchema } from './schema';

export interface LLMBackendMinimal {
  chat(options: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    responseFormat?: { type: 'json_object' };
  }): Promise<{ content: string }>;
}

export interface LLMEntityExtractorConfig {
  minConfidence?: number;
  maxEntitiesPerText?: number;
  maxRelationsPerText?: number;
}

const ExtractionOutputSchema = z.object({
  entities: z.array(ExtractedEntitySchema),
  relations: z.array(ExtractedRelationSchema),
});

const ENTITY_TYPES: EntityType[] = [
  'person',
  'organization',
  'location',
  'concept',
  'event',
  'object',
];

const RELATION_TYPES: RelationType[] = [
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
];

export class LLMEntityExtractor implements EntityExtractor {
  private backend: LLMBackendMinimal;
  private config: Required<LLMEntityExtractorConfig>;

  constructor(backend: LLMBackendMinimal, config: LLMEntityExtractorConfig = {}) {
    this.backend = backend;
    this.config = {
      minConfidence: config.minConfidence ?? 0.7,
      maxEntitiesPerText: config.maxEntitiesPerText ?? 20,
      maxRelationsPerText: config.maxRelationsPerText ?? 30,
    };
  }

  async extract(text: string, context?: ExtractionContext): Promise<ExtractionResult> {
    const systemPrompt = this.buildSystemPrompt(context);
    const userPrompt = this.buildUserPrompt(text, context);

    const response = await this.backend.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      responseFormat: { type: 'json_object' },
    });

    const parsed = this.parseResponse(response.content);

    const filteredEntities = parsed.entities
      .filter((e) => e.confidence >= this.config.minConfidence)
      .slice(0, this.config.maxEntitiesPerText);

    const entityNames = new Set(filteredEntities.map((e) => e.name.toLowerCase()));
    const filteredRelations = parsed.relations
      .filter(
        (r) =>
          r.confidence >= this.config.minConfidence &&
          entityNames.has(r.sourceEntity.toLowerCase()) &&
          entityNames.has(r.targetEntity.toLowerCase())
      )
      .slice(0, this.config.maxRelationsPerText);

    return {
      entities: filteredEntities,
      relations: filteredRelations,
      text,
      timestamp: new Date(),
    };
  }

  async extractBatch(texts: string[], context?: ExtractionContext): Promise<ExtractionResult[]> {
    const concurrency = 4;
    const results: ExtractionResult[] = new Array(texts.length);

    for (let i = 0; i < texts.length; i += concurrency) {
      const chunk = texts.slice(i, i + concurrency);
      const chunkResults = await Promise.all(chunk.map((text) => this.extract(text, context)));
      for (let j = 0; j < chunkResults.length; j++) {
        results[i + j] = chunkResults[j];
      }
    }

    return results;
  }

  private buildSystemPrompt(context?: ExtractionContext): string {
    const entityTypesStr = (context?.entityTypeHints ?? ENTITY_TYPES).join(', ');
    const relationTypesStr = (context?.relationTypeHints ?? RELATION_TYPES).join(', ');

    return `You are an entity and relationship extraction system. Your task is to extract structured information from text.

## Entity Types
Extract entities of these types: ${entityTypesStr}

## Relationship Types
Extract relationships of these types: ${relationTypesStr}

## Output Format
Return a JSON object with this structure:
{
  "entities": [
    {
      "name": "entity name",
      "type": "person|organization|location|concept|event|object",
      "aliases": ["alternative names"],
      "description": "brief description",
      "confidence": 0.0-1.0
    }
  ],
  "relations": [
    {
      "sourceEntity": "source entity name",
      "targetEntity": "target entity name",
      "type": "knows|works_at|located_in|part_of|related_to|created_by|belongs_to|associated_with|causes|precedes",
      "label": "optional relationship label",
      "confidence": 0.0-1.0
    }
  ]
}

## Guidelines
- Extract only explicitly mentioned or strongly implied entities and relationships
- Use confidence scores to indicate certainty (1.0 = certain, 0.5 = probable, 0.0 = uncertain)
- Normalize entity names (capitalize proper nouns, use full names when known)
- Include aliases for entities that are referred to in multiple ways
- Avoid duplicate entities (merge references to the same entity)
- For relationships, ensure both source and target entities are in the entities list`;
  }

  private buildUserPrompt(text: string, context?: ExtractionContext): string {
    let prompt = '';

    if (context?.existingEntities && context.existingEntities.length > 0) {
      prompt += `## Known Entities (for disambiguation)\n${context.existingEntities.join(', ')}\n\n`;
    }

    prompt += `## Text to Extract From\n${text}\n\n`;
    prompt += `Extract all entities and relationships from the text above. Return JSON only.`;

    return prompt;
  }

  private parseResponse(content: string): {
    entities: ExtractedEntity[];
    relations: ExtractedRelation[];
  } {
    try {
      const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      const result = ExtractionOutputSchema.safeParse(parsed);

      if (result.success) {
        return result.data;
      }

      if (parsed.entities && Array.isArray(parsed.entities)) {
        const entities: ExtractedEntity[] = [];
        for (const e of parsed.entities) {
          const entityResult = ExtractedEntitySchema.safeParse(e);
          if (entityResult.success) {
            entities.push(entityResult.data);
          }
        }

        const relations: ExtractedRelation[] = [];
        if (parsed.relations && Array.isArray(parsed.relations)) {
          for (const r of parsed.relations) {
            const relationResult = ExtractedRelationSchema.safeParse(r);
            if (relationResult.success) {
              relations.push(relationResult.data);
            }
          }
        }

        return { entities, relations };
      }

      return { entities: [], relations: [] };
    } catch {
      return { entities: [], relations: [] };
    }
  }
}
