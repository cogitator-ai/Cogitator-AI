import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  COGITATOR_ENCRYPTION_KEY: z.string().min(16).optional(),

  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  REDIS_URL: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  OLLAMA_URL: z.string().url().optional(),
  OLLAMA_HOST: z.string().optional(),

  COGITATOR_AUTH_ENABLED: z.enum(['true', 'false']).optional().default('true'),
  COGITATOR_REGISTRATION_ENABLED: z.enum(['true', 'false']).optional().default('true'),

  COGITATOR_ADMIN_EMAIL: z.string().email().optional(),
  COGITATOR_ADMIN_PASSWORD: z.string().min(8).optional(),

  NODE_ENV: z.enum(['development', 'production', 'test']).optional().default('development'),
});

export type Env = z.infer<typeof envSchema>;

let validatedEnv: Env | null = null;

export function validateEnv(): Env {
  if (validatedEnv) return validatedEnv;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues.map((e) => `  - ${e.path.join('.')}: ${e.message}`);
    console.error('Environment validation failed:');
    console.error(errors.join('\n'));

    if (process.env.NODE_ENV === 'production') {
      throw new Error(`Invalid environment configuration:\n${errors.join('\n')}`);
    }
  }

  const hasLLMProvider = !!(
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.OLLAMA_URL ||
    process.env.OLLAMA_HOST
  );

  if (!hasLLMProvider && process.env.NODE_ENV === 'production') {
    console.warn(
      'Warning: No LLM provider configured. Set at least one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, OLLAMA_URL'
    );
  }

  validatedEnv = result.success ? result.data : (process.env as unknown as Env);
  return validatedEnv;
}

export function getEnv(): Env {
  return validatedEnv || validateEnv();
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}
