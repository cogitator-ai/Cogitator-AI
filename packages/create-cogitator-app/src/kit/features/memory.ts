import { code } from '../code.js';
import type { ProjectBuilder } from '../project.js';
import { cogitatorVersion, IMAGES, VERSIONS } from '../versions.js';
import type { FeatureModule } from './types.js';

export const DEFAULT_DATABASE_URL = 'postgresql://cogitator:cogitator@localhost:5432/cogitator';
export const DEFAULT_REDIS_URL = 'redis://localhost:6379';
export const DEFAULT_MONGODB_URI = 'mongodb://localhost:27017';
export const SQLITE_PATH = './data/memory.db';

/** The Redis service compose starts, shared by Redis memory and the queue worker. */
export function addRedisService(project: ProjectBuilder): void {
  project.service(
    {
      name: 'redis',
      image: IMAGES.redis,
      ports: ['6379:6379'],
      volumes: ['redis_data:/data'],
      healthcheck: {
        test: ['CMD', 'redis-cli', 'ping'],
        interval: '5s',
        timeout: '3s',
        retries: 10,
      },
    },
    'redis_data'
  );
  project.envVar({
    name: 'REDIS_URL',
    description: 'The Redis server',
    example: DEFAULT_REDIS_URL,
    required: false,
    secret: false,
  });
}

/** The Postgres service with pgvector compose starts, shared by Postgres memory and the pgvector store. */
export function addPostgresService(project: ProjectBuilder): void {
  project.service(
    {
      name: 'postgres',
      image: IMAGES.postgres,
      ports: ['5432:5432'],
      environment: {
        POSTGRES_USER: 'cogitator',
        POSTGRES_PASSWORD: 'cogitator',
        POSTGRES_DB: 'cogitator',
      },
      volumes: ['postgres_data:/var/lib/postgresql'],
      healthcheck: {
        test: ['CMD-SHELL', 'pg_isready -U cogitator -d cogitator'],
        interval: '5s',
        timeout: '3s',
        retries: 10,
      },
    },
    'postgres_data'
  );
  project.dependency('pg', VERSIONS.pg);
  project.envVar({
    name: 'DATABASE_URL',
    description: 'The Postgres database',
    example: DEFAULT_DATABASE_URL,
    required: false,
    secret: true,
    deploy: true,
  });
}

export const memoryFeature: FeatureModule = {
  id: 'memory',
  applies: (spec) => spec.memory !== 'none',
  apply(project) {
    const { spec } = project;
    project.dependency('@cogitator-ai/memory', cogitatorVersion('@cogitator-ai/memory'));

    switch (spec.memory) {
      case 'memory':
        project.memoryYml.push('adapter: memory');
        break;
      case 'sqlite':
        project.dependency('better-sqlite3', VERSIONS.betterSqlite3).allowBuild('better-sqlite3');
        project.memoryYml.push('adapter: sqlite', 'sqlite:', `  path: ${SQLITE_PATH}`);
        project.ignore('data/');
        break;
      case 'postgres':
        addPostgresService(project);
        project.memoryYml.push(
          'adapter: postgres',
          'postgres:',
          `  connectionString: \${DATABASE_URL:-${DEFAULT_DATABASE_URL}}`
        );
        break;
      case 'redis':
        addRedisService(project);
        project
          .dependency('@cogitator-ai/redis', cogitatorVersion('@cogitator-ai/redis'))
          .dependency('ioredis', VERSIONS.ioredis);
        project.memoryYml.push(
          'adapter: redis',
          'redis:',
          `  url: \${REDIS_URL:-${DEFAULT_REDIS_URL}}`
        );
        break;
      case 'mongodb':
        project.service(
          {
            name: 'mongodb',
            image: IMAGES.mongodb,
            ports: ['27017:27017'],
            volumes: ['mongodb_data:/data/db'],
            healthcheck: {
              test: ['CMD', 'mongosh', '--quiet', '--eval', "db.adminCommand('ping')"],
              interval: '5s',
              timeout: '5s',
              retries: 10,
            },
          },
          'mongodb_data'
        );
        project.dependency('mongodb', VERSIONS.mongodb);
        project.envVar({
          name: 'MONGODB_URI',
          description: 'The MongoDB server',
          example: DEFAULT_MONGODB_URI,
          required: false,
          secret: true,
          deploy: true,
        });
        project.memoryYml.push(
          'adapter: mongodb',
          'mongodb:',
          `  uri: \${MONGODB_URI:-${DEFAULT_MONGODB_URI}}`,
          '  database: cogitator'
        );
        break;
      case 'none':
        break;
    }

    const where: Record<typeof spec.memory, string> = {
      none: '',
      memory: 'in the process, so it is gone after a restart',
      sqlite: `in SQLite at \`${SQLITE_PATH}\``,
      postgres: 'in Postgres (`DATABASE_URL`, started by `docker compose up -d`)',
      redis: 'in Redis (`REDIS_URL`, started by `docker compose up -d`)',
      mongodb: 'in MongoDB (`MONGODB_URI`, started by `docker compose up -d`)',
    };
    project.section(
      'Memory',
      code`
        Conversations are stored ${where[spec.memory]}. The \`memory\` section of \`cogitator.yml\` configures it, and runs with the same \`threadId\` continue the same conversation. Tests replace it with in-process memory.
      `
    );
  },
};
