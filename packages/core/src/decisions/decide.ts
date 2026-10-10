import { nanoid } from 'nanoid';
import { calculateCost } from '@cogitator-ai/models';
import {
  CogitatorError,
  ErrorCode,
  type CostRecord,
  type DecideOptions,
  type DecisionAnswer,
  type DecisionAnswers,
  type DecisionBackend,
  type DecisionQuestions,
  type DecisionResponse,
  type DecisionResult,
  type LLMRetryConfig,
  type RunObserver,
  type RunResult,
  type Span,
} from '@cogitator-ai/types';
import { llmInvalidResponse, type LLMErrorContext } from '../llm/errors';
import { retryLLMCall } from '../llm/retry';
import { createSpan } from '../cogitator/span-factory';
import { getLogger } from '../logger';

function invalid(message: string): CogitatorError {
  return new CogitatorError({ message, code: ErrorCode.VALIDATION_ERROR });
}

/** Fails with `VALIDATION_ERROR` on a request no decision model can answer. */
export function validateDecision(options: DecideOptions): void {
  if (!options.model?.trim())
    throw invalid('decide() needs a model, such as openrouter/typesafe/jev-1.13');
  const ids = Object.keys(options.questions ?? {});
  if (ids.length === 0) throw invalid('decide() needs at least one question');
  if (options.threshold !== undefined && !(options.threshold >= 0 && options.threshold <= 1)) {
    throw invalid(`The threshold must be between 0 and 1, got ${options.threshold}`);
  }
  for (const id of ids) {
    if (!id.trim()) throw invalid('A question id cannot be empty');
    const question = options.questions[id];
    switch (question.type) {
      case 'noul':
        if (!question.criteria?.true?.trim() || !question.criteria?.false?.trim()) {
          throw invalid(`Question "${id}" needs criteria for both true and false`);
        }
        break;
      case 'choice': {
        const choices = Object.keys(question.criteria ?? {});
        if (choices.length < 2) throw invalid(`Question "${id}" needs at least two options`);
        break;
      }
      case 'score':
        if (!Array.isArray(question.criteria) || question.criteria.length === 0) {
          throw invalid(`Question "${id}" needs at least one level`);
        }
        break;
      default:
        throw invalid(`Question "${id}" has an unknown type`);
    }
  }
}

function isProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/** The answers of `response` to `questions`, checked against them, yes or no by `threshold`. */
export function toDecisionAnswers<TQuestions extends DecisionQuestions>(
  questions: TQuestions,
  response: DecisionResponse,
  threshold: number,
  context: LLMErrorContext
): DecisionAnswers<TQuestions> {
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const raw = response.answers[id];
    if (!raw)
      throw llmInvalidResponse(context, `The decision model left question "${id}" unanswered`);
    if (raw.type !== question.type) {
      throw llmInvalidResponse(
        context,
        `Question "${id}" is ${question.type}, the decision model answered it as ${raw.type}`
      );
    }
    const probabilities = raw.type === 'noul' ? undefined : raw.probabilities;
    const outOfRange = [
      ...(raw.type === 'noul' ? [raw.noul] : []),
      ...(raw.type !== 'noul' && raw.confidence !== undefined ? [raw.confidence] : []),
      ...Object.values(probabilities ?? {}),
    ].find((value) => !isProbability(value));
    if (outOfRange !== undefined) {
      throw llmInvalidResponse(
        context,
        `Question "${id}" got a probability of ${outOfRange}, outside 0 to 1`
      );
    }
    if (raw.type === 'score' && !Number.isFinite(raw.score)) {
      throw llmInvalidResponse(context, `Question "${id}" got a score of ${raw.score}`);
    }
    if (raw.type === 'noul') {
      answers[id] = { type: 'noul', probability: raw.noul, value: raw.noul >= threshold };
    } else if (raw.type === 'choice') {
      if (question.type === 'choice' && !Object.hasOwn(question.criteria, raw.choice)) {
        throw llmInvalidResponse(
          context,
          `Question "${id}" got "${raw.choice}", which is not one of its options`
        );
      }
      answers[id] = {
        type: 'choice',
        choice: raw.choice,
        ...(raw.confidence !== undefined && { confidence: raw.confidence }),
        ...(raw.probabilities && { probabilities: raw.probabilities }),
      };
    } else {
      answers[id] = {
        type: 'score',
        score: raw.score,
        ...(raw.confidence !== undefined && { confidence: raw.confidence }),
        ...(raw.probabilities && { probabilities: raw.probabilities }),
        ...(raw.legend && { legend: raw.legend }),
      };
    }
  }
  return answers as DecisionAnswers<TQuestions>;
}

export interface DecisionRun {
  backend: DecisionBackend;
  /** The provider the model runs on, `openrouter`. */
  provider: string;
  /** The model as the provider names it, without the provider prefix. */
  model: string;
  retry: LLMRetryConfig | false | undefined;
  observers: readonly RunObserver[];
  recordCost?: (record: Omit<CostRecord, 'timestamp'>) => void;
}

function notify(
  observers: readonly RunObserver[],
  hook: string,
  call: (observer: RunObserver) => void
): void {
  for (const observer of observers) {
    try {
      call(observer);
    } catch (error) {
      getLogger().warn(`Run observer ${hook} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Asks the decision model, retrying as LLM calls do, prices the answer
 * (what the provider reported, else the model registry), and reports it to
 * the observers as a run of its own with one `llm.decide` span, so traces,
 * Langfuse and the cost of the Cogitator include it.
 */
export async function runDecision<TQuestions extends DecisionQuestions>(
  run: DecisionRun,
  options: DecideOptions<TQuestions>
): Promise<DecisionResult<TQuestions>> {
  validateDecision(options);
  const runId = `decide_${nanoid(12)}`;
  const traceId = `trace_${nanoid(16)}`;
  const qualified = `${run.provider}/${run.model}`;
  const started = Date.now();
  const context: LLMErrorContext = { provider: run.provider, model: run.model };
  notify(run.observers, 'onRunStart', (observer) =>
    observer.onRunStart?.({
      runId,
      agentId: 'decide',
      agentName: 'decide',
      input: typeof options.state === 'string' ? options.state : JSON.stringify(options.state),
      threadId: runId,
      model: qualified,
    })
  );
  try {
    const response = await retryLLMCall(
      run.retry,
      {
        provider: run.provider,
        model: run.model,
        ...(options.signal && { signal: options.signal }),
      },
      (signal) =>
        run.backend.decide({
          model: run.model,
          state: options.state,
          questions: options.questions,
          ...(signal && { signal }),
          ...(options.sessionId && { sessionId: options.sessionId }),
          ...(options.user && { user: options.user }),
        })
    );
    const answers = toDecisionAnswers(
      options.questions,
      response,
      options.threshold ?? 0.5,
      context
    );
    const ended = Date.now();
    const priced = response.usage.cost ?? calculateCost(qualified, response.usage);
    const usage = {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cost: priced ?? 0,
      priced: priced !== null,
      duration: ended - started,
    };
    const span: Span = createSpan(
      'llm.decide',
      traceId,
      undefined,
      started,
      ended,
      {
        'llm.model': response.model,
        'llm.provider': run.provider,
        'llm.input_tokens': usage.inputTokens,
        'llm.output_tokens': usage.outputTokens,
        'llm.cost': usage.cost,
        'decision.questions': Object.keys(options.questions).join(','),
        'decision.answers': JSON.stringify(answers),
        ...(response.id && { 'decision.id': response.id }),
      },
      'ok',
      'client'
    );
    notify(run.observers, 'onSpan', (observer) => observer.onSpan?.(span, { runId }));
    run.recordCost?.({
      runId,
      agentId: 'decide',
      model: qualified,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost: usage.cost,
    });
    const result: RunResult = {
      output: JSON.stringify(answers),
      structured: answers,
      runId,
      agentId: 'decide',
      threadId: runId,
      modelUsed: qualified,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
        cost: usage.cost,
        duration: usage.duration,
      },
      toolCalls: [],
      messages: [],
      trace: { traceId, spans: [span] },
    };
    notify(run.observers, 'onRunComplete', (observer) => observer.onRunComplete?.(result));
    return {
      answers,
      model: response.model,
      usage,
      ...(response.id && { id: response.id }),
      ...(response.provider && { provider: response.provider }),
    };
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    notify(run.observers, 'onRunError', (observer) => observer.onRunError?.(error, runId));
    throw error;
  }
}
