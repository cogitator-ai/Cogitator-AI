import type { BenchQuestion } from './types.js';

/** A request to the judge model and how its reply becomes a score from 0 to 1. */
export interface JudgeRequest {
  id: string;
  system?: string;
  prompt: string;
  maxTokens: number;
  read(reply: string): number;
}

/** How an answer is scored: right away, or by the judge model with one or more requests. */
export type Scoring =
  | { kind: 'score'; score: number }
  | { kind: 'judge'; requests: JudgeRequest[]; combine(scores: number[]): number };

const mean = (scores: number[]): number =>
  scores.length === 0 ? 0 : scores.reduce((sum, score) => sum + score, 0) / scores.length;

/** Text as SQuAD compares it: lower case, without punctuation, articles and extra spaces. */
export function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether any of `answers` appears in `prediction`, both normalized (MemoryAgentBench). */
export function substringMatch(prediction: string, answers: readonly string[]): boolean {
  const normalized = normalizeAnswer(prediction);
  return answers.some((answer) => {
    const expected = normalizeAnswer(answer);
    return expected.length > 0 && normalized.includes(expected);
  });
}

/** Token F1 between a prediction and a reference, both normalized (LoCoMo, SQuAD). */
export function tokenF1(prediction: string, reference: string): number {
  const predicted = normalizeAnswer(prediction).split(' ').filter(Boolean);
  const expected = normalizeAnswer(reference).split(' ').filter(Boolean);
  if (predicted.length === 0 || expected.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of expected) counts.set(token, (counts.get(token) ?? 0) + 1);
  let overlap = 0;
  for (const token of predicted) {
    const left = counts.get(token) ?? 0;
    if (left > 0) {
      overlap++;
      counts.set(token, left - 1);
    }
  }
  if (overlap === 0) return 0;
  const precision = overlap / predicted.length;
  const recall = overlap / expected.length;
  return (2 * precision * recall) / (precision + recall);
}

/*
 * LongMemEval answer check prompts, from src/evaluation/evaluate_qa.py of
 * https://github.com/xiaowu0162/LongMemEval (MIT License, Copyright (c) 2024 Di Wu).
 */
const LME_STANDARD =
  'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\nIs the model response correct? Answer yes or no only.';
const LME_TEMPORAL =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\nIs the model response correct? Answer yes or no only.";
const LME_UPDATE =
  'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\nIs the model response correct? Answer yes or no only.';
const LME_PREFERENCE =
  "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {question}\n\nRubric: {answer}\n\nModel Response: {response}\n\nIs the model response correct? Answer yes or no only.";
const LME_ABSTENTION =
  'I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {question}\n\nExplanation: {answer}\n\nModel Response: {response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.';

function lmeTemplate(questionType: string, abstention: boolean): string {
  if (abstention) return LME_ABSTENTION;
  switch (questionType) {
    case 'temporal-reasoning':
      return LME_TEMPORAL;
    case 'knowledge-update':
      return LME_UPDATE;
    case 'single-session-preference':
      return LME_PREFERENCE;
    default:
      return LME_STANDARD;
  }
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

const yesNo = (reply: string): number => (/\byes\b/i.test(reply.trim()) ? 1 : 0);

/*
 * BEAM rubric judge prompt (`unified_llm_judge_base_prompt`), from src/prompts.py of
 * https://github.com/mohammadtavakoli78/BEAM (MIT License).
 */
const BEAM_RUBRIC = `
You are an expert evaluator tasked with judging whether the LLM's response demonstrates compliance with the specified RUBRIC CRITERION.

## EVALUATION INPUTS
- RUBRIC CRITERION (what to check): <rubric_item>
- RESPONSE TO EVALUATE: <llm_response>

## EVALUATION RUBRIC:
The rubric defines a specific requirement, constraint, or expected behavior that the LLM response should demonstrate.

**IMPORTANT**: Pay careful attention to whether the rubric specifies:
- **Positive requirements** (things the response SHOULD include/do)
- **Negative constraints** (things the response SHOULD NOT include/do, often indicated by "no", "not", "avoid", "absent")

## RESPONSIVENESS REQUIREMENT
A compliant response must be **on-topic** and attempt to answer it.
- If the response does not address the QUESTION, score **0.0** and stop.
- For negative constraints, both must hold: (a) the response is responsive to the QUESTION, and (b) the prohibited element is absent.

## SEMANTIC TOLERANCE RULES:
Judge by meaning, not exact wording.
- Accept **paraphrases** and **synonyms** that preserve intent.
- **Case/punctuation/whitespace** differences must be ignored.
- **Numbers/currencies/dates** may appear in equivalent forms (e.g., "$68,000", "68k", "68,000 USD", or "sixty-eight thousand dollars"). Treat them as equal when numerically equivalent.
- If the rubric expects a number or duration, prefer **normalized comparison** (extract and compare values) over string matching.

## STYLE NEUTRALITY (prevents style contamination):
Ignore tone, politeness, length, and flourish unless the rubric explicitly requires a format/structure (e.g., "itemized list", "no citations", "one sentence").
- Do **not** penalize hedging, voice, or verbosity if content satisfies the rubric.
- Only evaluate format when the rubric **explicitly** mandates it.

## SCORING SCALE:
- **1.0 (Complete Compliance)**: Fully complies with the rubric criterion.
  - Positive: required element present, accurate, properly executed (allowing semantic equivalents).
  - Negative: prohibited element **absent** AND response is **responsive**.

- **0.5 (Partial Compliance)**: Partially complies.
  - Positive: element present but minor inaccuracies/incomplete execution.
  - Negative: generally responsive and mostly avoids the prohibited element but with minor/edge violations.

- **0.0 (No Compliance)**: Fails to comply.
  - Positive: required element missing or incorrect.
  - Negative: prohibited element present **or** response is non-responsive/evasive even if the element is absent.

## EVALUATION INSTRUCTIONS:
1. **Understand the Requirement**: Determine if the rubric is asking for something to be present (positive) or absent (negative/constraint).

2. **Parse Compound Statements**: If the rubric contains multiple elements connected by "and" or commas, evaluate whether:
   - **All elements** must be present for full compliance (1.0)
   - **Some elements** present indicates partial compliance (0.5)
   - **No elements** present indicates no compliance (0.0)

3. **Check Compliance**:
   - For positive requirements: Look for the presence and quality of the required element
   - For negative constraints: Look for the absence of the prohibited element

4. **Assign Score**: Based on compliance with the specific rubric criterion according to the scoring scale above.

5. **Provide Reasoning**: Explain whether the rubric criterion was satisfied and justify the score.

## OUTPUT FORMAT:
Return your evaluation in JSON format with two fields:

{
   "score": [your score: 1.0, 0.5, or 0.0],
   "reason": "[detailed explanation of whether the rubric criterion was satisfied and why this justified the assigned score]"
}

NOTE: ONLY output the json object, without any explanation before or after that
`;

/** The `score` of a JSON judgement (0, 0.5 or 1), or 0 for a reply it cannot read. */
export function readRubricScore(reply: string): number {
  const match = /"score"\s*:\s*\[?\s*([01](?:\.\d+)?)/.exec(reply);
  if (!match) return 0;
  const score = Number(match[1]);
  return Number.isFinite(score) ? Math.min(Math.max(score, 0), 1) : 0;
}

/*
 * LongMemEval-V2 evaluators, ported from evaluation/qa_eval_metrics.py of
 * https://github.com/xiaowu0162/LongMemEval-V2 (Apache License 2.0).
 */
export function extractBoxedAnswer(text: string): string {
  const marker = '\\boxed{';
  const start = text.lastIndexOf(marker);
  if (start === -1) return text.trim();
  let depth = 1;
  let out = '';
  for (let i = start + marker.length; i < text.length; i++) {
    const char = text[i];
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) break;
    }
    out += char;
  }
  const parsed = out.trim();
  return parsed || text.trim();
}

interface PhraseOptions {
  lower: boolean;
  normalizeHyphen: boolean;
  stripPunct: boolean;
  separators: string[];
}

function normalizePhrase(text: string, options: PhraseOptions): string {
  let result = text;
  if (options.lower) result = result.toLowerCase();
  if (options.normalizeHyphen) result = result.replace(/[-_]/g, ' ');
  result = result.replace(/[,;]/g, ' ');
  if (options.stripPunct) result = result.replace(/[^\p{L}\p{N}_\s]/gu, '');
  return result.replace(/\s+/g, ' ').trim();
}

function splitPhrases(text: string, options: PhraseOptions): string[] {
  const parts =
    options.separators.length === 0
      ? [text]
      : text.split(new RegExp(options.separators.map(escapeRegExp).join('|')));
  return parts.map((part) => normalizePhrase(part, options)).filter(Boolean);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phrasePattern(phrase: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}_])`, 'u');
}

export function phraseSetMatch(
  prediction: string,
  answer: string,
  options: PhraseOptions,
  ordered: boolean
): boolean {
  const normalized = normalizePhrase(prediction, options);
  const phrases = splitPhrases(answer, options);
  if (!normalized || phrases.length === 0) return false;
  if (!ordered)
    return [...new Set(phrases)].every((phrase) => phrasePattern(phrase).test(normalized));
  let rest = normalized;
  for (const phrase of phrases) {
    const match = phrasePattern(phrase).exec(rest);
    if (!match) return false;
    rest = rest.slice(match.index + match[0].length);
  }
  return true;
}

export function choiceMatch(prediction: string, answer: string): boolean {
  const boxed = /\\boxed\{([^}]*)\}/.exec(prediction.toLowerCase());
  const candidate = boxed ? boxed[1] : prediction;
  const cleaned = candidate
    .replace(/\b(choice|option)\b/gi, '')
    .replace(/\./g, '')
    .trim()
    .toUpperCase();
  const expected = answer.trim().toUpperCase();
  return Boolean(cleaned) && Boolean(expected) && cleaned === expected;
}

const SELECT_FILLER = new Set([
  'AND',
  'ANSWER',
  'ANSWERS',
  'CHOICE',
  'CHOICES',
  'FINAL',
  'LETTER',
  'LETTERS',
  'OPTION',
  'OPTIONS',
]);

function selectLetters(text: string): string[] {
  return (text.toUpperCase().match(/[A-Z]+/g) ?? []).flatMap((chunk) =>
    SELECT_FILLER.has(chunk) ? [] : [...chunk]
  );
}

export function choiceSetMatch(prediction: string, answer: string): boolean {
  const predicted = selectLetters(prediction);
  const expected = selectLetters(answer);
  if (predicted.length === 0 || expected.length === 0) return false;
  const a = new Set(predicted);
  const b = new Set(expected);
  return a.size === b.size && [...a].every((letter) => b.has(letter));
}

/** An LME-V2 `eval_function` spec (`name|key=value|...`) as its name and options. */
export function parseEvalSpec(spec: string): { name: string; options: PhraseOptions } {
  const [name, ...parts] = spec.split('|').map((part) => part.trim());
  const options: PhraseOptions = {
    lower: true,
    normalizeHyphen: true,
    stripPunct: true,
    separators: [',', ';'],
  };
  for (const part of parts) {
    const [key, value = ''] = part.split('=', 2);
    if (key === 'lower') options.lower = value === 'true';
    if (key === 'normalize_hyphen') options.normalizeHyphen = value === 'true';
    if (key === 'strip_punct') options.stripPunct = value === 'true';
    if (key === 'separators') options.separators = [...value].filter((char) => !/\s/.test(char));
  }
  return { name, options };
}

const LME_V2_ABSTENTION_SYSTEM =
  "You are a strict grader for flawed-premise (abstention) questions. Judge whether a model answer correctly identifies that the question premise is wrong, consistent with the reference answer. If the model follows the flawed premise and gives a concrete answer under that premise, it must be graded 0. If the model's final answer is just UNKNOWN / cannot determine without identifying the flaw, grade 0. If the model is contradictory (both rejects premise and also gives a concrete premise-following answer), grade 0. Paraphrases are allowed when they preserve the same core flaw described by the reference answer.";
const LME_V2_GOTCHAS_SYSTEM =
  "You are a strict grader for gotchas-style insight questions. The reference answer describes the key insight(s). Grade 1 if the model response includes at least one correct insight point from the reference answer (paraphrase allowed), and does not contradict any reference point. If the model's direction is wrong, or it contains contradictions against any reference point, grade 0. If the model gives multiple points, partial coverage is enough for 1 as long as no contradictions appear.";

function lmeV2AbstentionPrompt(question: string, answer: string, full: string, final: string) {
  return `Evaluate whether the model correctly handled a flawed-premise question.\n\nQuestion:\n${question}\n\nReference answer (the expected flaw-aware conclusion):\n${answer}\n\nModel full response:\n${full}\n\nModel extracted final answer:\n${final}\n\nScoring rubric:\n- Label 1 only if the model clearly identifies the flawed premise and reaches a conclusion equivalent to the reference answer.\n- Label 1 also if the model explicitly says it lacks access to the user's specific live environment/instance/configuration and therefore cannot verify, provided it does not give a concrete premise-following answer.\n- Label 0 if the model follows the flawed premise and gives a concrete answer under that premise.\n- Label 0 for generic UNKNOWN/insufficient-info replies that do not identify a flaw and do not make the explicit environment-access limitation clear.\n- Label 0 if contradictory.\n\nOutput JSON only:\n{"label": 0 or 1, "reason": "short rationale"}`;
}

function lmeV2GotchasPrompt(question: string, answer: string, full: string, final: string) {
  return `Evaluate whether the model answer captures the gotcha insight.\n\nQuestion:\n${question}\n\nReference answer (insight points):\n${answer}\n\nModel full response:\n${full}\n\nModel extracted final answer:\n${final}\n\nScoring rubric:\n- Label 1 if the model includes at least one correct insight point from the reference answer (paraphrase acceptable), and does not contradict any reference point.\n- Label 1 even if only part of a multi-point reference answer is covered, as long as there is no contradiction.\n- Label 0 if direction is wrong (suggests opposite action/cause), even if some wording overlaps.\n- Label 0 if any point in the model response contradicts any reference point.\n- Label 0 if the response is irrelevant or generic without insight.\n\nOutput JSON only:\n{"label": 0 or 1, "reason": "short rationale"}`;
}

/** The `label` (0 or 1) of a binary JSON judgement, or 0 for a reply it cannot read. */
export function readBinaryLabel(reply: string): number {
  const match = /["']?label["']?\s*[:=]\s*["']?([01])/i.exec(reply);
  return match?.[1] === '1' ? 1 : 0;
}

/** How the answer `output` to `question` is scored. */
export function scoringFor(question: BenchQuestion, output: string): Scoring {
  const { scoring } = question;
  switch (scoring.kind) {
    case 'substring':
      return { kind: 'score', score: substringMatch(output, scoring.answers) ? 1 : 0 };
    case 'token-f1':
      return { kind: 'score', score: tokenF1(output, question.answer) };
    case 'longmemeval':
      return {
        kind: 'judge',
        requests: [
          {
            id: question.id,
            prompt: fill(lmeTemplate(scoring.questionType, scoring.abstention), {
              question: question.question,
              answer: question.answer,
              response: output,
            }),
            maxTokens: 16,
            read: yesNo,
          },
        ],
        combine: mean,
      };
    case 'beam-rubric':
      return {
        kind: 'judge',
        requests: scoring.rubric.map((item, index) => ({
          id: `${question.id}:${index}`,
          prompt: BEAM_RUBRIC.replace('<rubric_item>', item).replace('<llm_response>', output),
          maxTokens: 512,
          read: readRubricScore,
        })),
        combine: mean,
      };
    case 'lme-v2': {
      const final = extractBoxedAnswer(output);
      if (final.trim().toLowerCase() === 'unknown') return { kind: 'score', score: 0 };
      const { name, options } = parseEvalSpec(scoring.evalFunction);
      if (name === 'llm_abstention_checker' || name === 'llm_gotchas_checker') {
        if (!output.trim()) return { kind: 'score', score: 0 };
        const abstention = name === 'llm_abstention_checker';
        return {
          kind: 'judge',
          requests: [
            {
              id: question.id,
              system: abstention ? LME_V2_ABSTENTION_SYSTEM : LME_V2_GOTCHAS_SYSTEM,
              prompt: (abstention ? lmeV2AbstentionPrompt : lmeV2GotchasPrompt)(
                question.question,
                question.answer,
                output.trim(),
                final
              ),
              maxTokens: 256,
              read: readBinaryLabel,
            },
          ],
          combine: mean,
        };
      }
      const correct =
        name === 'norm_phrase_set_match' || name === 'norm_phrase_set_match_ordered'
          ? phraseSetMatch(final, question.answer, options, name.endsWith('_ordered'))
          : name === 'mc_choice_match'
            ? choiceMatch(final, question.answer)
            : name === 'mc_choice_set_match'
              ? choiceSetMatch(final, question.answer)
              : false;
      return { kind: 'score', score: correct ? 1 : 0 };
    }
  }
}
