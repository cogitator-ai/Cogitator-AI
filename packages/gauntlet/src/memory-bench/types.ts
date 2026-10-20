/** One turn of a conversation the memory holds. */
export interface BenchTurn {
  role: 'user' | 'assistant';
  content: string;
  /** When it was said, when the dataset knows */
  at?: Date;
  /** The dataset marks this turn as holding the answer to one of the questions */
  evidence?: boolean;
}

/** How a question's answer is scored. */
export type BenchScoring =
  | { kind: 'longmemeval'; questionType: string; abstention: boolean }
  | { kind: 'beam-rubric'; rubric: string[] }
  | { kind: 'substring'; answers: string[] }
  | { kind: 'lme-v2'; evalFunction: string }
  | { kind: 'token-f1' };

/** A question asked against a conversation the memory holds. */
export interface BenchQuestion {
  id: string;
  /** The ability it tests, as the dataset names it (question type, category) */
  category: string;
  question: string;
  /** The reference answer, or the rubric's ideal answer */
  answer: string;
  /** "Today" when the question is asked, as the dataset writes it, for questions about time */
  askedOn?: string;
  scoring: BenchScoring;
  /** Texts of the turns that hold the answer, when the dataset marks them */
  evidence?: string[];
}

/** A conversation to put into memory and the questions to ask about it. */
export interface BenchConversation {
  id: string;
  dataset: BenchDatasetId;
  turns: BenchTurn[];
  questions: BenchQuestion[];
  /**
   * The dataset's own answering rules (its system prompt, its conflict rule), added to the
   * agent's instructions rather than to the question, so retrieval searches the question alone
   */
  protocol?: string;
}

export type BenchDatasetId =
  | 'longmemeval-s'
  | 'beam-100k'
  | 'beam-500k'
  | 'beam-1m'
  | 'mab-conflict'
  | 'lme-v2-small'
  | 'locomo';

/** How the run answers: the memory strategy and the context it may fill. */
export interface BenchStrategy {
  name: 'recent' | 'relevant' | 'hybrid';
  /** Token budget of the built context (`memory.contextBuilder.maxTokens`) */
  contextTokens: number;
}

/** What one question's run produced. */
export interface BenchAnswer {
  dataset: BenchDatasetId;
  conversationId: string;
  questionId: string;
  category: string;
  strategy: string;
  output: string;
  /** Tokens and cost of the answering run */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  /** Wall time of the run, and the part spent outside model calls (building the context) */
  durationMs: number;
  contextMs: number;
  /** Messages and tokens the model got */
  contextMessages: number;
  contextTokens: number;
  /** Share of the evidence turns that reached the model, when the dataset marks them */
  evidenceRecall?: number;
  error?: string;
}

/** A judged answer. */
export interface BenchScore extends BenchAnswer {
  /** 0 to 1 */
  score: number;
  judgeCostUsd: number;
  judgeNote?: string;
}
