import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { Agent, Cogitator, PostgresTraceStore } from '@cogitator-ai/core';

const describeDurable =
  process.env.GOOGLE_API_KEY && process.env.TEST_POSTGRES_URL ? describe : describe.skip;
const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;
const MODEL = 'google/gemini-3.5-flash-lite';

const agent = () =>
  new Agent({
    name: 'greeter',
    model: MODEL,
    instructions: 'Reply with exactly the single word APPLE and nothing else.',
    temperature: 0,
  });

function cogitatorWith(prompts: ConstructorParameters<typeof Cogitator>[0]['prompts']) {
  return new Cogitator({
    llm: { providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } } },
    prompts,
  });
}

describeDurable('Core: prompt versions in Postgres', () => {
  const schema = `e2e_prompts_${process.pid}`;
  let store: PostgresTraceStore;

  beforeAll(async () => {
    store = new PostgresTraceStore({ connectionString: process.env.TEST_POSTGRES_URL!, schema });
    await store.connect();
  });

  afterAll(async () => {
    await store.disconnect();
    const client = new pg.Client({ connectionString: process.env.TEST_POSTGRES_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('runs a deployed version in a new process and rolls back', { timeout: 120_000 }, async () => {
    const prompts = { versions: store.instructionVersions(), abTests: store.abTests() };
    const first = cogitatorWith(prompts);
    const v1 = await first.prompts.deploy(
      'greeter',
      'Reply with exactly the single word BANANA and nothing else.'
    );
    await first.close();

    const second = cogitatorWith(prompts);
    const deployed = await second.run(agent(), { input: 'Go.' });
    expect(deployed.output.toUpperCase()).toContain('BANANA');
    expect(deployed.prompt).toEqual({ key: 'greeter', versionId: v1.id, version: 1 });
    expect((await second.prompts.current('greeter'))?.metrics.runCount).toBe(1);

    await second.prompts.deploy('greeter', 'Reply with exactly the single word CHERRY.');
    await second.prompts.rollbackTo('greeter');
    const rolledBack = await second.run(agent(), { input: 'Go.' });
    expect(rolledBack.output.toUpperCase()).toContain('BANANA');
    expect(rolledBack.prompt?.version).toBe(3);
    await second.close();
  });
});

describeGoogle('Core: prompt A/B tests', () => {
  let cogitator: Cogitator;

  beforeAll(() => {
    cogitator = cogitatorWith({});
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('keeps a thread on its variant and runs its instructions', { timeout: 180_000 }, async () => {
    await cogitator.prompts.startABTest(agent(), {
      name: 'fruit',
      treatment: 'Reply with exactly the single word MANGO and nothing else.',
      minSampleSize: 1000,
    });

    for (const threadId of ['t-1', 't-2', 't-3', 't-4']) {
      const runs = [
        await cogitator.run(agent(), { input: 'Go.', threadId }),
        await cogitator.run(agent(), { input: 'Again.', threadId }),
      ];
      const variants = runs.map((run) => run.prompt?.abTest?.variant);
      expect(new Set(variants).size).toBe(1);
      const word = variants[0] === 'treatment' ? 'MANGO' : 'APPLE';
      for (const run of runs) expect(run.output.toUpperCase()).toContain(word);
    }
  });
});
