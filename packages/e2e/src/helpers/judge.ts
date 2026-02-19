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
            'Keep the reason under 20 words. Nothing else. No markdown. No code fences.',
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
      maxTokens: 512,
    });

    const text = response.content.trim();
    return this.parseJudgeResponse(text);
  }

  private parseJudgeResponse(text: string): JudgeResult {
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as JudgeResult;
        return { pass: Boolean(parsed.pass), reason: parsed.reason };
      } catch {}
    }

    const passMatch = /"pass"\s*:\s*(true|false)/.exec(text);
    if (passMatch) {
      const pass = passMatch[1] === 'true';
      const reasonMatch = /"reason"\s*:\s*"([^"]*)/i.exec(text);
      return { pass, reason: reasonMatch?.[1] ?? 'truncated response' };
    }

    return { pass: false, reason: `Judge returned unparseable: ${text.slice(0, 200)}` };
  }
}
