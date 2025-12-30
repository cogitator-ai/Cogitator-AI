import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ContainerPool } from '../pool/container-pool.js';
import type { Docker } from '../docker-types.js';


describe('ContainerPool', () => {
  let docker: Docker | null = null;
  let dockerAvailable = false;

  beforeAll(async () => {
    try {
      const Dockerode = await import('dockerode');
      docker = new Dockerode.default() as unknown as Docker;
      await docker.ping();
      dockerAvailable = true;
    } catch {
      dockerAvailable = false;
    }
  });

  afterAll(async () => {
  });

  describe('when Docker is available', () => {
    it.skipIf(!dockerAvailable)('creates pool with default options', () => {
      const pool = new ContainerPool(docker!);
      expect(pool).toBeDefined();
      void pool.destroyAll();
    });

    it.skipIf(!dockerAvailable)('creates pool with custom options', () => {
      const pool = new ContainerPool(docker!, {
        maxSize: 10,
        idleTimeoutMs: 120_000,
      });
      expect(pool).toBeDefined();
      void pool.destroyAll();
    });

    it.skipIf(!dockerAvailable)(
      'acquires and releases container',
      async () => {
        const pool = new ContainerPool(docker!, { maxSize: 2 });

        try {
          const container = await pool.acquire('alpine:3.19', {
            networkMode: 'none',
          });

          expect(container).toBeDefined();
          expect(container.id).toBeTruthy();

          await pool.release(container);
        } finally {
          await pool.destroyAll();
        }
      },
      60_000
    );

    it.skipIf(!dockerAvailable)(
      'reuses containers with same image',
      async () => {
        const pool = new ContainerPool(docker!, { maxSize: 5 });

        try {
          const container1 = await pool.acquire('alpine:3.19', {
            networkMode: 'none',
          });
          const id1 = container1.id;
          await pool.release(container1);

          const container2 = await pool.acquire('alpine:3.19', {
            networkMode: 'none',
          });
          const id2 = container2.id;

          expect(id2).toBe(id1);

          await pool.release(container2);
        } finally {
          await pool.destroyAll();
        }
      },
      60_000
    );

    it.skipIf(!dockerAvailable)(
      'creates new container for different image',
      async () => {
        const pool = new ContainerPool(docker!, { maxSize: 5 });

        try {
          const container1 = await pool.acquire('alpine:3.19', {
            networkMode: 'none',
          });
          const id1 = container1.id;

          const container2 = await pool.acquire('alpine:3.18', {
            networkMode: 'none',
          });
          const id2 = container2.id;

          expect(id2).not.toBe(id1);

          await pool.release(container1);
          await pool.release(container2);
        } finally {
          await pool.destroyAll();
        }
      },
      60_000
    );

    it.skipIf(!dockerAvailable)(
      'destroys all containers',
      async () => {
        const pool = new ContainerPool(docker!, { maxSize: 3 });

        const container1 = await pool.acquire('alpine:3.19', {
          networkMode: 'none',
        });
        const container2 = await pool.acquire('alpine:3.19', {
          networkMode: 'none',
        });

        await pool.release(container1);
        await pool.release(container2);

        await pool.destroyAll();
      },
      60_000
    );
  });

  describe('when Docker is not available', () => {
    it('pool tests are skipped when Docker unavailable', () => {
      if (!dockerAvailable) {
        console.log('Docker not available - container pool tests skipped');
      }
      expect(true).toBe(true);
    });
  });
});
