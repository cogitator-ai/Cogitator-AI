import { Agent } from '@cogitator-ai/core';
import { SwarmBuilder, type Swarm } from '@cogitator-ai/swarms';
import type {
  StrategyResult,
  SwarmEvent,
  SwarmEventType,
  SwarmRunOptions,
} from '@cogitator-ai/types';
import type { StageContext, StageDefinition } from '../../runner/types.js';
import { CORE, SWARMS, excerpt, vendorOf } from './shared.js';

declare module '../../runner/types.js' {
  interface GauntletArtifacts {
    /** The article topic the editors' swarm agreed on. */
    orchestrationTopic: string;
  }
}

const TOPICS = {
  A: 'Night trains are back on European timetables',
  B: 'Cities put beehives on rooftops to help pollinators',
  C: 'Solid-state batteries move from the lab to the factory floor',
} as const;

type TopicLetter = keyof typeof TOPICS;

const BALLOT = [
  "Choose the topic of today's lead article. The candidates are:",
  ...Object.entries(TOPICS).map(([letter, topic]) => `${letter}) ${topic}`),
  'Vote with the letter only, for example "VOTE: A".',
].join('\n');

/** The letter after `Decision:` or `FINAL DECISION:` in a consensus output. */
function decidedLetter(output: string): TopicLetter | undefined {
  const match = /(?:final decision|decision)\s*:\s*[*_"'`(]*\s*(?:option\s+)?([abc])\b/i.exec(
    output
  );
  const letter = match?.[1]?.toUpperCase();
  return letter === 'A' || letter === 'B' || letter === 'C' ? letter : undefined;
}

/** Runs the swarm, recording its events, and aborts it when the stage is cancelled. */
async function runSwarm(
  ctx: StageContext,
  swarm: Swarm,
  options: SwarmRunOptions
): Promise<{ result: StrategyResult; events: SwarmEvent[] }> {
  const events: SwarmEvent[] = [];
  const unsubscribe = swarm.on('*', (event) => {
    events.push(event);
  });
  const abort = () => swarm.abort();
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    return { result: await swarm.run(options), events };
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    unsubscribe();
  }
}

function countByType(events: SwarmEvent[]): Partial<Record<SwarmEventType, number>> {
  const counts: Partial<Record<SwarmEventType, number>> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

function agentOf(event: SwarmEvent): string | undefined {
  if (event.agentName) return event.agentName;
  const data = event.data;
  if (typeof data === 'object' && data !== null && 'agentName' in data) {
    return typeof data.agentName === 'string' ? data.agentName : undefined;
  }
  return undefined;
}

/** Agents with both an `agent:start` and an `agent:complete` event. */
function agentsThatRan(events: SwarmEvent[]): Set<string> {
  const started = new Set(events.filter((e) => e.type === 'agent:start').map(agentOf));
  return new Set(
    events
      .filter((e) => e.type === 'agent:complete')
      .map(agentOf)
      .filter((name): name is string => name !== undefined && started.has(name))
  );
}

/** Three editors on three vendors vote on the topic; the chief editor breaks a deadlock. */
const swarmTopic: StageDefinition = {
  id: 'swarm-topic',
  title: 'Swarm: editors vote on the topic',
  description:
    'Three editors on models from different vendors pick the article topic with the consensus strategy, with the chief editor as tie-breaker.',
  packages: [SWARMS, CORE],
  needs: ['handshake'],
  timeoutMs: 240_000,
  async run(ctx) {
    const editors = ctx.models.map(
      (model, index) =>
        new Agent({
          name: `editor-${index + 1}-${vendorOf(model)}`,
          model,
          instructions:
            'You are a section editor at a small online newsroom. When asked to choose, write the line "VOTE: <letter>" with a single letter, then one short sentence of reasoning.',
          maxIterations: 3,
        })
    );
    const chief = new Agent({
      name: 'chief-editor',
      model: ctx.model,
      instructions:
        'You are the chief editor. When the desk cannot agree, you decide: write the line "FINAL DECISION: <letter>" with a single letter, then one sentence of reasoning.',
      maxIterations: 2,
    });
    const swarm = new SwarmBuilder('newsroom-topic')
      .strategy('consensus')
      .supervisor(chief)
      .agents(editors)
      .consensus({
        threshold: 0.6,
        maxRounds: 2,
        resolution: 'majority',
        onNoConsensus: 'supervisor-decides',
      })
      .build(ctx.cogitator);
    ctx.log(`Editors: ${editors.map((editor) => editor.name).join(', ')}`);
    const { result, events } = await runSwarm(ctx, swarm, {
      input: BALLOT,
      timeout: 220_000,
      saveHistory: false,
    });

    await ctx.check('every editor ran and voted', (evidence) => {
      const ran = agentsThatRan(events);
      const votes: Record<string, unknown> = {};
      for (const [key, vote] of result.votes ?? []) {
        votes[key] =
          typeof vote === 'object' && vote !== null && 'decision' in vote ? vote.decision : vote;
      }
      evidence('ran', [...ran]);
      evidence('votes', votes);
      const silent = editors.filter(
        (editor) => !result.agentResults.has(`${editor.name}_round1`) || !ran.has(editor.name)
      );
      if (silent.length)
        throw new Error(`No round-1 turn from ${silent.map((e) => e.name).join(', ')}`);
      if (Object.keys(votes).length < 2) {
        throw new Error('The strategy counted fewer than two ballots');
      }
    });

    const topic = await ctx.check('the desk settles on a listed topic', (evidence) => {
      const output = String(result.output);
      const reached = events.some((event) => event.type === 'consensus:reached');
      const chiefRan = result.agentResults.has(chief.name);
      const letter = decidedLetter(output);
      evidence('path', reached ? 'consensus' : chiefRan ? 'chief editor' : 'none');
      evidence('rounds', events.filter((event) => event.type === 'consensus:round').length);
      evidence('decision', letter);
      evidence('output', excerpt(output));
      if (!reached && !chiefRan) throw new Error('Neither consensus nor the chief editor decided');
      if (!letter) throw new Error('The decision names none of the candidate letters');
      evidence('topic', TOPICS[letter]);
      return TOPICS[letter];
    });
    ctx.artifacts.set('orchestrationTopic', topic);

    await ctx.check('swarm and consensus events fire', (evidence) => {
      const counts = countByType(events);
      evidence('events', counts);
      const required: SwarmEventType[] = [
        'swarm:start',
        'swarm:complete',
        'consensus:round',
        'consensus:turn',
        'agent:start',
        'agent:complete',
      ];
      const missing = required.filter((type) => !counts[type]);
      if (missing.length) throw new Error(`Missing events: ${missing.join(', ')}`);
      if ((counts['consensus:turn'] ?? 0) < editors.length) {
        throw new Error(`Expected a consensus turn per editor, saw ${counts['consensus:turn']}`);
      }
    });
  },
};

const EXPERTISE = [
  ['science', 'energy', 'technology'],
  ['transport', 'cities', 'travel'],
  ['environment', 'nature', 'agriculture'],
];

/** The three reporters bid for the assignment; the best-suited one writes the lede. */
const swarmAssignment: StageDefinition = {
  id: 'swarm-assignment',
  title: 'Swarm: reporters bid for the story',
  description:
    'Reporters on three vendors bid for the chosen topic with the auction strategy and the highest bidder writes the lede.',
  packages: [SWARMS, CORE],
  needs: ['swarm-topic'],
  timeoutMs: 180_000,
  async run(ctx) {
    const topic = ctx.artifacts.get('orchestrationTopic');
    const reporters = ctx.models.map(
      (model, index) =>
        new Agent({
          name: `reporter-${index + 1}-${vendorOf(model)}`,
          model,
          instructions:
            'You are a reporter. When asked to bid, answer exactly in the requested SCORE / CAPABILITIES / REASONING format. When you get an assignment, write only what it asks for.',
          maxIterations: 2,
        })
    );
    const swarm = new SwarmBuilder('newsroom-assignment')
      .strategy('auction')
      .agents(reporters)
      .agentMetadata(
        Object.fromEntries(
          reporters.map((reporter, index) => [
            reporter.name,
            { expertise: EXPERTISE[index % EXPERTISE.length] },
          ])
        )
      )
      .auction({ bidding: 'capability-match', selection: 'highest-bid' })
      .build(ctx.cogitator);
    const { result, events } = await runSwarm(ctx, swarm, {
      input: `Write a two-sentence opening paragraph (the lede) for a news article titled "${topic}". Plain text, no headline.`,
      timeout: 160_000,
      saveHistory: false,
    });

    await ctx.check('every reporter bids', (evidence) => {
      const bids = Object.fromEntries(result.bids ?? []);
      evidence('bids', bids);
      evidence('bidEvents', events.filter((event) => event.type === 'auction:bid').length);
      const missing = reporters.filter((reporter) => !(reporter.name in bids));
      if (missing.length) throw new Error(`No bid from ${missing.map((r) => r.name).join(', ')}`);
      const invalid = Object.entries(bids).filter(([, score]) => !(score >= 0 && score <= 1));
      if (invalid.length) throw new Error(`Bids outside 0..1: ${JSON.stringify(invalid)}`);
      const ran = agentsThatRan(events);
      const idle = reporters.filter((reporter) => !ran.has(reporter.name));
      if (idle.length)
        throw new Error(`No agent turn events for ${idle.map((r) => r.name).join(', ')}`);
    });

    await ctx.check('the highest bidder writes the lede', (evidence) => {
      const bids = [...(result.bids ?? [])];
      const best = Math.max(...bids.map(([, score]) => score));
      const winner = result.auctionWinner;
      const lede = String(result.output).trim();
      evidence('winner', winner);
      evidence('winningBid', winner ? result.bids?.get(winner) : undefined);
      evidence('lede', excerpt(lede, 240));
      if (!winner) throw new Error('The auction named no winner');
      if (result.bids?.get(winner) !== best) {
        throw new Error(`Winner ${winner} did not have the highest bid (${best})`);
      }
      if (!result.agentResults.has(winner)) throw new Error('The winner has no run result');
      if (lede.length < 40) throw new Error('The lede is missing or too short');
    });

    await ctx.check('auction state lands on the blackboard', (evidence) => {
      const board = swarm.blackboard.read<{ status?: string; winner?: string }>('auction');
      const types = new Set(events.map((event) => event.type));
      evidence('blackboard', { status: board?.status, winner: board?.winner });
      evidence('events', countByType(events));
      if (board?.status !== 'completed' || board.winner !== result.auctionWinner) {
        throw new Error('The blackboard does not record the finished auction');
      }
      for (const type of ['auction:start', 'auction:winner', 'auction:complete'] as const) {
        if (!types.has(type)) throw new Error(`Missing event ${type}`);
      }
    });
  },
};

export const swarmStages: StageDefinition[] = [swarmTopic, swarmAssignment];
