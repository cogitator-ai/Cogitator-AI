import { z } from 'zod';

const McpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
});

const AssistantChannelsSchema = z.object({
  telegram: z.object({ ownerIds: z.array(z.string()).optional() }).optional(),
  discord: z.object({ ownerIds: z.array(z.string()).optional() }).optional(),
  slack: z.object({ ownerIds: z.array(z.string()).optional() }).optional(),
});

const AssistantCapabilitiesSchema = z.object({
  webSearch: z.boolean().optional(),
  fileSystem: z.object({ paths: z.array(z.string()) }).optional(),
  github: z.boolean().optional(),
  deviceTools: z.boolean().optional(),
  browser: z
    .union([
      z.boolean(),
      z.object({
        headless: z.boolean().default(true),
        stealth: z.boolean().default(false),
      }),
    ])
    .optional(),
  scheduler: z.boolean().optional(),
  rag: z.object({ paths: z.array(z.string()) }).optional(),
  selfConfig: z.boolean().optional(),
  selfTools: z
    .union([
      z.boolean(),
      z.object({
        path: z.string().optional(),
      }),
    ])
    .optional(),
});

const AssistantMemorySchema = z.object({
  adapter: z.enum(['sqlite', 'postgres']).default('sqlite'),
  path: z.string().optional(),
  autoExtract: z.boolean().default(true),
  knowledgeGraph: z.boolean().default(true),
  compaction: z.object({ threshold: z.number() }).optional(),
});

const SecuritySchema = z
  .object({
    dmPolicy: z.enum(['open', 'allowlist', 'pairing', 'disabled']).default('open'),
    allowlist: z.array(z.string()).optional(),
    groupPolicy: z.enum(['open', 'allowlist', 'disabled']).default('open'),
    groupAllowlist: z.array(z.string()).optional(),
    storePath: z.string().optional(),
  })
  .optional();

export const AssistantConfigSchema = z.object({
  name: z.string(),
  personality: z.string(),
  llm: z.object({
    provider: z.enum(['google', 'openai', 'anthropic', 'ollama']),
    model: z.string(),
  }),
  channels: AssistantChannelsSchema.optional().default({}),
  capabilities: AssistantCapabilitiesSchema.optional().default({}),
  mcpServers: z.record(z.string(), McpServerSchema).optional(),
  memory: AssistantMemorySchema.optional().default({
    adapter: 'sqlite',
    autoExtract: true,
    knowledgeGraph: true,
  }),
  security: SecuritySchema,
  stream: z
    .object({
      flushInterval: z.number().default(600),
      minChunkSize: z.number().default(30),
    })
    .optional(),
  rateLimit: z
    .object({
      maxPerMinute: z.number().default(30),
    })
    .optional(),
});

export type AssistantConfigInput = z.input<typeof AssistantConfigSchema>;
export type AssistantConfigOutput = z.output<typeof AssistantConfigSchema>;
