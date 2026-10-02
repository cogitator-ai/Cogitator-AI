import { describe, it, expect } from 'vitest';
import { toClaudeStrictJsonSchema } from '../llm/claude-json-schema';

describe('toClaudeStrictJsonSchema', () => {
  it('closes every object and keeps supported keywords', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'closed'] },
        kind: { const: 'ticket' },
        created: { type: 'string', format: 'date-time' },
        code: { type: 'string', pattern: '^[A-Z]+$' },
        owner: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
          additionalProperties: true,
        },
        labels: { type: 'array', items: { type: 'object', properties: {} }, minItems: 1 },
        note: { type: ['string', 'null'], default: null },
      },
      required: ['status'],
    };

    expect(toClaudeStrictJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'closed'] },
        kind: { const: 'ticket' },
        created: { type: 'string', format: 'date-time' },
        code: { type: 'string', pattern: '^[A-Z]+$' },
        owner: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
          additionalProperties: false,
        },
        labels: {
          type: 'array',
          items: { type: 'object', properties: {}, additionalProperties: false },
          minItems: 1,
        },
        note: { type: ['string', 'null'], default: null },
      },
      required: ['status'],
      additionalProperties: false,
    });
  });

  it('moves unsupported constraints into the description', () => {
    expect(
      toClaudeStrictJsonSchema({
        type: 'object',
        properties: {
          age: { type: 'integer', description: 'Age in years', minimum: 0, maximum: 150 },
          name: { type: 'string', minLength: 1, maxLength: 20, format: 'phone' },
          items: {
            type: 'array',
            items: { type: 'number', multipleOf: 0.5 },
            minItems: 3,
            maxItems: 9,
          },
        },
      })
    ).toEqual({
      type: 'object',
      properties: {
        age: { type: 'integer', description: 'Age in years\n\n{minimum: 0, maximum: 150}' },
        name: { type: 'string', description: '{minLength: 1, maxLength: 20, format: "phone"}' },
        items: {
          type: 'array',
          items: { type: 'number', description: '{multipleOf: 0.5}' },
          description: '{minItems: 3, maxItems: 9}',
        },
      },
      additionalProperties: false,
    });
  });

  it('rewrites oneOf to anyOf and recurses into combinators and definitions', () => {
    expect(
      toClaudeStrictJsonSchema({
        type: 'object',
        properties: {
          value: {
            oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'null' }],
          },
          ref: { $ref: '#/$defs/item' },
        },
        $defs: { item: { type: 'object', properties: { n: { type: 'number', minimum: 1 } } } },
      })
    ).toEqual({
      type: 'object',
      properties: {
        value: {
          anyOf: [
            {
              type: 'object',
              properties: { a: { type: 'string' } },
              additionalProperties: false,
            },
            { type: 'null' },
          ],
        },
        ref: { $ref: '#/$defs/item' },
      },
      $defs: {
        item: {
          type: 'object',
          properties: { n: { type: 'number', description: '{minimum: 1}' } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
  });

  it('does not treat property names as keywords', () => {
    expect(
      toClaudeStrictJsonSchema({
        type: 'object',
        properties: { minimum: { type: 'number' }, format: { type: 'string' } },
      })
    ).toEqual({
      type: 'object',
      properties: { minimum: { type: 'number' }, format: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('never mutates the input', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string', minLength: 2 } },
    };
    const snapshot = structuredClone(schema);

    toClaudeStrictJsonSchema(schema);

    expect(schema).toEqual(snapshot);
  });
});
