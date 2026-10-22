import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { Agent, Cogitator } from '@cogitator-ai/core';
import { Swarm, swarmQueueKeys } from '@cogitator-ai/swarms';
import { DistributedSwarmWorker } from '@cogitator-ai/worker';

const redisUrl =
  process.env.TEST_REDIS === 'true'
    ? (process.env.TEST_REDIS_URL ?? 'redis://localhost:6379')
    : undefined;
const describeLive = redisUrl && process.env.GOOGLE_API_KEY ? describe : describe.skip;

const MODEL = 'google/gemini-3.5-flash-lite';
const fixture = fileURLToPath(new URL('../../helpers/hanging-swarm-worker.ts', import.meta.url));

/** Start the hanging worker in its own process and wait for it to take a turn */
function hangingWorker(keyPrefix: string): {
  child: ChildProcess;
  workerId: Promise<string>;
  taken: Promise<string>;
} {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
    env: {
      ...process.env,
      SWARM_REDIS_URL: redisUrl,
      SWARM_KEY_PREFIX: keyPrefix,
      SWARM_HEARTBEAT_INTERVAL: '200',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  const line = (pattern: RegExp) =>
    new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        const match = pattern.exec(output);
        if (match) {
          child.stdout?.off('data', onData);
          resolve(match[1]!);
        }
      };
      child.stdout?.on('data', onData);
      child.once('exit', (code) => reject(new Error(`hanging worker exited with ${code}`)));
    });
  return { child, workerId: line(/started (\S+)/), taken: line(/taken (\S+)/) };
}

describeLive('Swarms: distributed turns on a reliable queue', () => {
  const keyPrefix = `e2e-reliable-${Date.now()}`;
  const children: ChildProcess[] = [];

  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL');
    const client = new Redis(redisUrl!);
    const keys = await client.keys(`${keyPrefix}:*`);
    if (keys.length > 0) await client.del(...keys);
    client.disconnect();
  });

  it(
    'hands the turn of a worker killed mid-run to another worker',
    { timeout: 120_000 },
    async () => {
      const hanging = hangingWorker(keyPrefix);
      children.push(hanging.child);
      const deadWorkerId = await hanging.workerId;

      const swarm = new Swarm(
        new Cogitator({
          llm: {
            defaultModel: MODEL,
            providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
          },
        }),
        {
          name: 'reliable-queue-e2e',
          strategy: 'pipeline',
          pipeline: {
            stages: [
              {
                name: 'answer',
                agent: new Agent({
                  name: 'answerer',
                  model: MODEL,
                  instructions: 'Reply with one short sentence.',
                  temperature: 0,
                }),
              },
            ],
          },
          distributed: { enabled: true, timeout: 90_000, redis: { url: redisUrl, keyPrefix } },
        }
      );

      const running = swarm.run({ input: 'Say hello to Redis.' });
      const jobId = await hanging.taken;
      const keys = swarmQueueKeys(keyPrefix);
      const client = new Redis(redisUrl!);
      expect(await client.llen(keys.processing(deadWorkerId))).toBe(1);

      hanging.child.kill('SIGKILL');
      const recovered: [string, number][] = [];
      const rescuer = new DistributedSwarmWorker(
        {
          redis: { url: redisUrl },
          keyPrefix,
          heartbeatInterval: 200,
          pollTimeout: 0.1,
          cogitator: new Cogitator({
            llm: {
              defaultModel: MODEL,
              providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
            },
          }),
        },
        { onJobsRecovered: (workerId, count) => recovered.push([workerId, count]) }
      );
      await rescuer.start();

      try {
        const result = await running;

        expect(String(result.output).length).toBeGreaterThan(0);
        expect(recovered).toEqual([[deadWorkerId, 1]]);
        expect(await client.llen(keys.processing(deadWorkerId))).toBe(0);
        expect(await client.sismember(keys.workers, deadWorkerId)).toBe(0);
        expect(await client.keys(`${keyPrefix}:*:result:${jobId}`)).toHaveLength(1);
      } finally {
        await swarm.close();
        await rescuer.stop();
        client.disconnect();
      }
    }
  );
});
