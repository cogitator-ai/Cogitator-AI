import type { GoogleBackend } from '@cogitator-ai/core';

interface JudgeResult {
  pass: boolean;
  reason?: string;
}

interface EvaluateOptions {
  question: string;
  answer: string;
  criteria: string;
}

export class LLMJudge {
  private backend: GoogleBackend;
  private model: string;

  constructor(backend: GoogleBackend, model: string) {
    this.backend = backend;
    this.model = model;
  }

  async evaluate(opts: EvaluateOptions): Promise<JudgeResult> {
    const response = await this.backend.chat({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: [
            'You are a test evaluator. Given a question, an answer, and evaluation criteria,',
            'determine if the answer meets the criteria.',
            'Reply ONLY with valid JSON: {"pass": true, "reason": "brief explanation"}',
            'or {"pass": false, "reason": "brief explanation"}.',
            'Nothing else. No markdown. No code fences.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            `Question: ${opts.question}`,
            `Answer: ${opts.answer}`,
            `Criteria: ${opts.criteria}`,
          ].join('\n'),
        },
      ],
      temperature: 0,
      maxTokens: 256,
    });

    const text = response.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { pass: false, reason: `Judge returned non-JSON: ${text}` };
    }

    const parsed = JSON.parse(jsonMatch[0]) as JudgeResult;
    return {
      pass: Boolean(parsed.pass),
      reason: parsed.reason,
    };
  }
}
