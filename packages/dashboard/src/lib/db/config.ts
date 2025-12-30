import { query, queryOne, execute } from './index';
import { encrypt, decrypt, isEncrypted, maskApiKey } from '../crypto';

export async function getConfig<T>(key: string): Promise<T | null> {
  const row = await queryOne<{ value: T }>(
    'SELECT value FROM dashboard_config WHERE key = $1',
    [key]
  );
  return row?.value || null;
}

export async function setConfig<T>(key: string, value: T): Promise<void> {
  await execute(
    `INSERT INTO dashboard_config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

export async function deleteConfig(key: string): Promise<boolean> {
  const count = await execute('DELETE FROM dashboard_config WHERE key = $1', [key]);
  return count > 0;
}

export async function getAllConfig(): Promise<Record<string, unknown>> {
  const rows = await query<{ key: string; value: unknown }>(
    'SELECT key, value FROM dashboard_config'
  );
  
  const config: Record<string, unknown> = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return config;
}

export interface CogitatorConfig {
  llm: {
    provider: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
  };
  memory?: {
    adapter: string;
    redis?: { url: string };
    postgres?: { url: string };
  };
  sandbox?: {
    enabled: boolean;
    type: string;
    timeout?: number;
  };
  limits?: {
    maxTurns?: number;
    maxTokens?: number;
    maxCost?: number;
  };
}

export async function getCogitatorConfig(): Promise<CogitatorConfig | null> {
  return getConfig<CogitatorConfig>('cogitator');
}

export async function setCogitatorConfig(config: CogitatorConfig): Promise<void> {
  await setConfig('cogitator', config);
}


export interface ApiKeysConfig {
  openai?: string;
  anthropic?: string;
  google?: string;
}

export interface ApiKeysStatus {
  openai: boolean;
  anthropic: boolean;
  google: boolean;
}

export async function setApiKeys(keys: ApiKeysConfig): Promise<void> {
  const encrypted: ApiKeysConfig = {};

  if (keys.openai) encrypted.openai = encrypt(keys.openai);
  if (keys.anthropic) encrypted.anthropic = encrypt(keys.anthropic);
  if (keys.google) encrypted.google = encrypt(keys.google);

  await setConfig('api_keys_encrypted', encrypted);
}

export async function getApiKeys(): Promise<ApiKeysConfig> {
  const encrypted = await getConfig<ApiKeysConfig>('api_keys_encrypted');
  if (!encrypted) return {};

  const decrypted: ApiKeysConfig = {};

  try {
    if (encrypted.openai && isEncrypted(encrypted.openai)) {
      decrypted.openai = decrypt(encrypted.openai);
    }
    if (encrypted.anthropic && isEncrypted(encrypted.anthropic)) {
      decrypted.anthropic = decrypt(encrypted.anthropic);
    }
    if (encrypted.google && isEncrypted(encrypted.google)) {
      decrypted.google = decrypt(encrypted.google);
    }
  } catch {
    return {};
  }

  return decrypted;
}

export async function getApiKeysStatus(): Promise<ApiKeysStatus> {
  const encrypted = await getConfig<ApiKeysConfig>('api_keys_encrypted');

  return {
    openai: !!(encrypted?.openai || process.env.OPENAI_API_KEY),
    anthropic: !!(encrypted?.anthropic || process.env.ANTHROPIC_API_KEY),
    google: !!(encrypted?.google || process.env.GOOGLE_API_KEY),
  };
}

export async function getMaskedApiKeys(): Promise<Record<string, string>> {
  const keys = await getApiKeys();
  const masked: Record<string, string> = {};

  if (keys.openai) masked.openai = maskApiKey(keys.openai);
  if (keys.anthropic) masked.anthropic = maskApiKey(keys.anthropic);
  if (keys.google) masked.google = maskApiKey(keys.google);

  return masked;
}

