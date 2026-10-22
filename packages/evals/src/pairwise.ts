import type { EvalSuiteResult } from './eval-suite';
import type { MetricUsage, ScoredCaseResult } from './metrics/types';
import type { JudgeContext } from './metrics/llm-judge';
import { judgePrompt, parseJudgeOutput, sumUsage, usageOf } from './metrics/llm-judge';
import { conversationBlock, evidenceBlock, tagged, wrapped } from './metrics/judge-prompt';

export interface PairwiseOptions {
  /** What makes one answer better than the other. Default: correct, relevant, complete, clear */
  criteria?: string;
  /** The name the result reports. Default `pairwise` */
  name?: string;
}

export type PairwiseSide = 'baseline' | 'challenger';

export type PairwiseOutcome = PairwiseSide | 'tie';

/** One of the two verdicts on a case */
export interface PairwiseVerdict {
  /** The side shown to the judge first, as answer A */
  first: PairwiseSide;
  /** The side the judge preferred, or `tie` */
  preferred: PairwiseOutcome;
  reasoning?: string;
}

export interface PairwiseCase {
  /** Position of the case in the dataset */
  index: number;
  input: string;
  winner: PairwiseOutcome;
  /** The verdict with the baseline first, then the one with the challenger first */
  verdicts: PairwiseVerdict[];
  /** The side that errored and so lost the case without a judge call */
  errored?: PairwiseSide;
  /** Why the judge gave no verdict in one of the orders, which makes the case a tie */
  error?: string;
}

export interface PairwiseResult {
  name: string;
  wins: { baseline: number; challenger: number };
  ties: number;
  /** Cases compared: those at least one side answered */
  cases: number;
  /** Challenger wins over the decided cases (wins of either side), NaN when none was decided */
  winRate: number;
  /** Cases the judge failed on in at least one order, counted as ties */
  judgeErrors: number;
  /** USD the judge calls cost, as far as the judge reported usage */
  cost: number;
  perCase: PairwiseCase[];
}

/** The instructions of a pairwise verdict */
function pairwiseInstructions(criteria: string | undefined): string {
  const basis = criteria
    ? `on these criteria:\n${criteria}`
    : 'overall: which is more correct, relevant, complete and clear';
  return `You are comparing two answers to the same request to decide which one is better ${basis}\n\nThe order of the answers says nothing about their quality, and a longer answer is better only for what its length adds.\n\nScore 0 when <answer_a> is better, 1 when <answer_b> is better, 0.5 when neither is better.\n\nRespond with JSON: {"score": <0, 0.5 or 1>, "reasoning": "<explanation>"}`;
}

/** The case and the two answers, A then B. A multi-turn case shows each side's whole conversation */
function pairwiseMessage(a: ScoredCaseResult, b: ScoredCaseResult): string {
  const evidence = evidenceBlock(a, false);
  const multiTurn = (a.case.turns?.length ?? 0) > 0;
  const shared = [
    ...(multiTurn
      ? ['Each answer is a whole conversation, the user messages being the same in both.']
      : [tagged('input', a.case.input)]),
    ...(evidence === undefined ? [] : [evidence]),
    ...(a.case.expected ? [tagged('expected', a.case.expected)] : []),
  ];
  const answer = (tag: string, result: ScoredCaseResult) =>
    multiTurn ? wrapped(tag, conversationBlock(result)) : tagged(tag, result.output);
  return [...shared, answer('answer_a', a), answer('answer_b', b)].join('\n');
}

interface Asked {
  verdict?: PairwiseVerdict;
  error?: string;
  usage?: MetricUsage;
}

const other = (side: PairwiseSide): PairwiseSide =>
  side === 'baseline' ? 'challenger' : 'baseline';

async function ask(
  judge: JudgeContext,
  instructions: string,
  first: PairwiseSide,
  a: ScoredCaseResult,
  b: ScoredCaseResult
): Promise<Asked> {
  try {
    const answered = await judge.cogitator.run({
      input: judgePrompt(instructions, pairwiseMessage(a, b)),
    });
    const usage = usageOf(answered.usage);
    const verdict = parseJudgeOutput(answered.output);
    if (!verdict) return { error: 'could not parse judge response', ...(usage && { usage }) };
    const score = verdict.outOf === undefined ? verdict.score : verdict.score / verdict.outOf;
    const preferred: PairwiseOutcome = score < 0.5 ? first : score > 0.5 ? other(first) : 'tie';
    return {
      verdict: {
        first,
        preferred,
        ...(verdict.reasoning !== undefined && { reasoning: verdict.reasoning }),
      },
      ...(usage && { usage }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A case judged both ways round: the baseline first, then the challenger first. Agreeing
 * verdicts give the case to that side, disagreeing ones or a tie make it a tie
 */
async function judgeCase(
  judge: JudgeContext,
  instructions: string,
  index: number,
  baseline: ScoredCaseResult,
  challenger: ScoredCaseResult
): Promise<{ result: PairwiseCase; usage?: MetricUsage }> {
  const input = baseline.case.input;
  if (baseline.error !== undefined || challenger.error !== undefined) {
    const errored: PairwiseSide = baseline.error !== undefined ? 'baseline' : 'challenger';
    return { result: { index, input, winner: other(errored), verdicts: [], errored } };
  }
  const asked = await Promise.all([
    ask(judge, instructions, 'baseline', baseline, challenger),
    ask(judge, instructions, 'challenger', challenger, baseline),
  ]);
  const usage = sumUsage(asked.map((one) => one.usage));
  const verdicts = asked.flatMap((one) => (one.verdict ? [one.verdict] : []));
  const errors = asked.flatMap((one) => (one.error === undefined ? [] : [one.error]));
  const [first, second] = verdicts;
  const winner: PairwiseOutcome =
    errors.length === 0 && first.preferred === second.preferred ? first.preferred : 'tie';
  return {
    result: {
      index,
      input,
      winner,
      verdicts,
      ...(errors.length > 0 && { error: errors.join(', ') }),
    },
    ...(usage && { usage }),
  };
}

/**
 * Asks the judge which side answered each case better, see `EvalComparisonOptions.pairwise`.
 * Cases both sides errored on are left out
 */
export async function judgePairwise(
  baseline: EvalSuiteResult,
  challenger: EvalSuiteResult,
  judge: JudgeContext,
  options: PairwiseOptions,
  concurrency: number,
  signal?: AbortSignal
): Promise<PairwiseResult> {
  const instructions = pairwiseInstructions(options.criteria);
  const pairs = baseline.results.flatMap((b, index) => {
    const c = challenger.results[index];
    return c && (b.error === undefined || c.error === undefined) ? [{ index, b, c }] : [];
  });

  const judged = new Array<{ result: PairwiseCase; usage?: MetricUsage }>(pairs.length);
  let next = 0;
  const worker = async () => {
    while (next < pairs.length && !signal?.aborted) {
      const at = next++;
      const { index, b, c } = pairs[at];
      judged[at] = await judgeCase(judge, instructions, index, b, c);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pairs.length) }, worker));
  signal?.throwIfAborted();

  const perCase = judged.map((one) => one.result);
  const wins = {
    baseline: perCase.filter((one) => one.winner === 'baseline').length,
    challenger: perCase.filter((one) => one.winner === 'challenger').length,
  };
  const decided = wins.baseline + wins.challenger;
  return {
    name: options.name ?? 'pairwise',
    wins,
    ties: perCase.length - decided,
    cases: perCase.length,
    winRate: decided === 0 ? Number.NaN : wins.challenger / decided,
    judgeErrors: perCase.filter((one) => one.error !== undefined).length,
    cost: judged.reduce((sum, one) => sum + (one.usage?.cost ?? 0), 0),
    perCase,
  };
}
