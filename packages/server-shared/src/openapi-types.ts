export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    description?: string;
    version: string;
    contact?: {
      name?: string;
      email?: string;
      url?: string;
    };
    license?: {
      name: string;
      url?: string;
    };
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  security?: Array<Record<string, string[]>>;
  tags?: Array<{ name: string; description?: string }>;
}

export interface SwaggerConfig {
  title?: string;
  description?: string;
  version?: string;
  contact?: {
    name?: string;
    email?: string;
    url?: string;
  };
  license?: {
    name: string;
    url?: string;
  };
  /** Where the API is mounted; adapters fill in their own base path when this is not set */
  servers?: Array<{ url: string; description?: string }>;
  /**
   * The server checks credentials (an adapter with `auth`): the spec then
   * declares an optional bearer token, so Swagger UI offers to send one.
   */
  auth?: boolean;
}

export interface OpenAPIContext {
  agents: Record<
    string,
    {
      config: {
        instructions?: string;
        tools?: Array<{ name: string; description?: string; parameters: unknown }>;
      };
    }
  >;
  workflows: Record<string, { entryPoint: string; nodes: Map<string, unknown> }>;
  swarms: Record<
    string,
    {
      strategy: string;
      supervisor?: { name: string };
      workers?: Array<{ name: string }>;
      agents?: Array<{ name: string }>;
      moderator?: { name: string };
      blackboard?: { enabled?: boolean; sections?: Record<string, unknown> };
    }
  >;
}
