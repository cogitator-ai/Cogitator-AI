import { describe, it, expect } from 'vitest';
import { Agent, Cogitator } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';

const apiKey = process.env.GOOGLE_API_KEY ?? '';
const describeGoogle = apiKey ? describe : describe.skip;
const MODEL = 'google/gemini-2.5-flash';

describeGoogle('Swarms: debate turns of a reasoning model', () => {
  it(
    'answers every turn though reasoning takes more than the turn limit',
    { timeout: 180_000 },
    async () => {
      const cogitator = new Cogitator({
        llm: {
          defaultModel: MODEL,
          providers: { google: { apiKey } },
        },
      });
      const pro = new Agent({
        name: 'pro',
        model: MODEL,
        instructions: 'You argue in favour. Think it through, then answer in one sentence.',
      });
      const con = new Agent({
        name: 'con',
        model: MODEL,
        instructions: 'You argue against. Think it through, then answer in one sentence.',
      });

      const swarm = new Swarm(cogitator, {
        name: 'debate-reasoning',
        strategy: 'debate',
        agents: [pro, con],
        agentMetadata: { pro: { role: 'advocate' }, con: { role: 'critic' } },
        debate: { rounds: 1, maxTokensPerTurn: 48 },
      });

      const result = await swarm.run({
        input: 'Cities should replace every parking lot with housing',
        saveHistory: false,
      });

      const turns = ['pro_round1', 'con_round1'].map((key) => result.agentResults.get(key));
      for (const turn of turns) {
        expect(turn?.output.trim().length).toBeGreaterThan(0);
      }
      expect(turns.some((turn) => (turn?.usage.reasoningTokens ?? 0) > 0)).toBe(true);
      await cogitator.close();
    }
  );
});
