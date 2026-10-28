import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_SERVER_METHODS,
  APP_SERVER_NOTIFICATIONS,
  APP_SERVER_SCHEMAS,
} from '../protocol/methods';
import { generateJsonSchema } from '../codegen/json-schema';
import { generateTypeScriptClient, printType } from '../codegen/typescript';
import { AppServerClient, type AppServerClientTransport } from '../client/generated';

const GENERATED = fileURLToPath(new URL('../client/generated.ts', import.meta.url));

describe('codegen', () => {
  it('has the committed client in step with the schemas', () => {
    const committed = readFileSync(GENERATED, 'utf8');
    const fresh = generateTypeScriptClient();
    expect(
      fresh === committed,
      'src/client/generated.ts is stale: run pnpm --filter @cogitator-ai/app-server generate'
    ).toBe(true);
  });

  it('bundles every type, method and notification into one JSON Schema', () => {
    const bundle = generateJsonSchema();
    expect(Object.keys(bundle.$defs)).toEqual(APP_SERVER_SCHEMAS.map(([name]) => name));
    expect(Object.keys(bundle['x-methods'])).toEqual(Object.keys(APP_SERVER_METHODS));
    expect(Object.keys(bundle['x-notifications'])).toEqual(Object.keys(APP_SERVER_NOTIFICATIONS));
    expect(bundle['x-methods']['turn/start']).toMatchObject({
      params: { $ref: '#/$defs/TurnStartParams' },
      result: { $ref: '#/$defs/TurnStartResult' },
      clientName: 'turnStart',
    });
    expect(bundle['x-serverRequests']['approval/request']?.params.$ref).toBe(
      '#/$defs/ApprovalRequestParams'
    );
    for (const schema of Object.values(bundle.$defs)) {
      expect(schema).not.toHaveProperty('$id');
      expect(schema).not.toHaveProperty('additionalProperties', false);
    }
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
  });

  it('prints JSON Schema as TypeScript types', () => {
    expect(printType({ type: 'string' })).toBe('string');
    expect(printType({ type: ['string', 'null'] })).toBe('string | null');
    expect(printType({ enum: ['a', "it's"] })).toBe("'a' | 'it\\'s'");
    expect(printType({ const: 3 })).toBe('3');
    expect(printType({ $ref: '#/$defs/Thread' })).toBe('Thread');
    expect(
      printType({ type: 'array', items: { anyOf: [{ type: 'number' }, { type: 'boolean' }] } })
    ).toBe('Array<number | boolean>');
    expect(printType({ type: 'object', additionalProperties: { type: 'number' } })).toBe(
      'Record<string, number>'
    );
    expect(printType({})).toBe('unknown');
    expect(
      printType({
        type: 'object',
        properties: { 'a-b': { type: 'string', description: 'Dashed' }, c: { type: 'integer' } },
        required: ['c'],
      })
    ).toBe("{\n  /** Dashed */\n  'a-b'?: string;\n  c: number;\n}");
  });

  it('gives the generated client a method per request', () => {
    const source = generateTypeScriptClient();
    for (const entry of Object.values(APP_SERVER_METHODS)) {
      expect(source).toContain(`  ${entry.clientName}(`);
    }
    expect(source).toContain('threadList(params: ThreadListParams = {})');
    expect(source).toContain('turnStart(params: TurnStartParams)');
    expect(source).not.toMatch(/^import /m);
  });

  it('answers server requests it has no handler for with method not found', async () => {
    const sent: string[] = [];
    let deliver: (line: string) => void = () => undefined;
    const transport: AppServerClientTransport = {
      send: (line) => sent.push(line),
      onLine: (callback) => {
        deliver = callback;
      },
      close: () => undefined,
    };
    const client = new AppServerClient(transport);
    deliver('{"jsonrpc":"2.0","id":9,"method":"approval/request","params":{}}');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(sent[0]!)).toMatchObject({ id: 9, error: { code: -32601 } });

    const pending = client.threadList();
    deliver('not json');
    deliver(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { threads: [] } }));
    await expect(pending).resolves.toEqual({ threads: [] });
    const failing = client.threadList();
    client.close();
    await expect(failing).rejects.toThrow('closed');
  });
});
