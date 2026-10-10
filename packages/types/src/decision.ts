/**
 * Decision models: models that answer typed questions about a state with
 * probabilities instead of writing text, such as TypeSafe's Jev on
 * OpenRouter's Decisions API.
 */

/** What a question is about or how to judge it: text, or structured data the model reads as is. */
export type DecisionContent = string | Record<string, unknown> | readonly unknown[];

/** A yes or no question: does this condition hold? */
export interface NoulQuestion {
  type: 'noul';
  instructions: DecisionContent;
  /** What makes the answer true and what makes it false. */
  criteria: { true: string; false: string };
}

/** Which one of these options? The keys of `criteria` are the options. */
export interface ChoiceQuestion<TOption extends string = string> {
  type: 'choice';
  instructions: DecisionContent;
  /** Each option with what makes it the answer. */
  criteria: Record<TOption, string>;
}

/** Where does it fall on an ordered scale? `criteria` lists the levels, lowest first. */
export interface ScoreQuestion {
  type: 'score';
  instructions: DecisionContent;
  /** The levels of the scale, lowest first, at least one. */
  criteria: readonly [string, ...string[]];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** The questions of a request by their ids, which the answers come back under. */
export type DecisionQuestions = Record<string, DecisionQuestion>;

export interface NoulAnswer {
  type: 'noul';
  /** How likely the condition holds, from 0 to 1. */
  probability: number;
  /** Whether `probability` reaches the request's threshold, 0.5 unless set. */
  value: boolean;
}

export interface ChoiceAnswer<TOption extends string = string> {
  type: 'choice';
  choice: TOption;
  confidence?: number;
  /** How likely each option is, where the model reports it. */
  probabilities?: Partial<Record<TOption, number>>;
}

export interface ScoreAnswer {
  type: 'score';
  /** The position on the scale, as the model reports it. */
  score: number;
  confidence?: number;
  /** How likely each level is, where the model reports it. */
  probabilities?: Record<string, number>;
  /** What each level means, where the model reports it. */
  legend?: Record<string, string>;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The answer a question gets: a choice question answers with one of its options. */
export type DecisionAnswerOf<TQuestion> = TQuestion extends NoulQuestion
  ? NoulAnswer
  : TQuestion extends ChoiceQuestion<infer TOption>
    ? ChoiceAnswer<TOption>
    : TQuestion extends ScoreQuestion
      ? ScoreAnswer
      : never;

/** The answers to a set of questions, under the same ids. */
export type DecisionAnswers<TQuestions extends DecisionQuestions> = {
  [K in keyof TQuestions]: DecisionAnswerOf<TQuestions[K]>;
};

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
  /** In USD: what the provider reported, else priced from the model registry, else 0. */
  cost: number;
  /** Whether `cost` is known, reported or priced, rather than 0 for want of a price. */
  priced: boolean;
  /** Milliseconds the request took, retries included. */
  duration: number;
}

export interface DecideOptions<TQuestions extends DecisionQuestions = DecisionQuestions> {
  /** A decision model, with its provider: `openrouter/typesafe/jev-1.13`. */
  model: string;
  /** What the questions are about. */
  state: DecisionContent;
  questions: TQuestions;
  /** The probability from which a yes or no question answers true. Default 0.5. */
  threshold?: number;
  signal?: AbortSignal;
  /** Groups requests in the provider's observability. */
  sessionId?: string;
  /** The end user the request is made for, as the provider's `user`. */
  user?: string;
}

export interface DecisionResult<TQuestions extends DecisionQuestions = DecisionQuestions> {
  answers: DecisionAnswers<TQuestions>;
  /** The model that answered, as the provider names it. */
  model: string;
  usage: DecisionUsage;
  /** The provider's id of the request. */
  id?: string;
  /** The upstream provider that served it, where the router reports it. */
  provider?: string;
}

/** A request as a decision backend receives it: the model without its provider prefix. */
export interface DecisionRequest {
  model: string;
  state: DecisionContent;
  questions: DecisionQuestions;
  signal?: AbortSignal;
  sessionId?: string;
  user?: string;
}

/** An answer as a backend returns it, before the runtime applies the threshold. */
export type RawDecisionAnswer =
  | { type: 'noul'; noul: number }
  | {
      type: 'choice';
      choice: string;
      confidence?: number;
      probabilities?: Record<string, number>;
    }
  | {
      type: 'score';
      score: number;
      confidence?: number;
      probabilities?: Record<string, number>;
      legend?: Record<string, string>;
    };

export interface DecisionResponse {
  model: string;
  answers: Record<string, RawDecisionAnswer>;
  usage: { inputTokens: number; outputTokens: number; cost?: number };
  id?: string;
  provider?: string;
}

/** A provider of decision models: OpenRouter's Decisions API, or a custom one. */
export interface DecisionBackend {
  readonly provider: string;
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}
