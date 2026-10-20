import { describe, it, expect } from 'vitest';
import { parsePythonLiteral } from '../python-literal.js';
import { parseBeamAnchor, stripBeamMarker, beamConversation } from '../datasets/beam.js';
import { parseLongMemEvalDate, longMemEvalConversation } from '../datasets/longmemeval.js';
import {
  chunkFacts,
  conflictConversation,
  CONFLICT_INSTRUCTION,
} from '../datasets/memory-agent-bench.js';
import { trajectoryTurns, lmeV2Conversations, TREE_CHARS } from '../datasets/longmemeval-v2.js';
import { locomoConversation } from '../datasets/locomo.js';

describe('parsePythonLiteral', () => {
  it('reads dicts, lists, tuples, strings with escapes, numbers and keywords', () => {
    expect(
      parsePythonLiteral(
        `{'a': [1, 2.5, -3], "b": ('x', True, None), 'c': 'it\\'s "quoted"\\n', 'd': False, 'e': {}}`
      )
    ).toEqual({ a: [1, 2.5, -3], b: ['x', true, null], c: 'it\'s "quoted"\n', d: false, e: {} });
  });

  it('joins adjacent strings and reads unicode escapes', () => {
    expect(parsePythonLiteral(`['ab' "cd", '\\u00e9\\x41']`)).toEqual(['abcd', 'éA']);
  });

  it('keeps a __proto__ key as data', () => {
    const value = parsePythonLiteral(`{'__proto__': {'polluted': True}}`) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses text that is not a literal', () => {
    expect(() => parsePythonLiteral(`{'a': 1} extra`)).toThrow(/unexpected text/);
    expect(() => parsePythonLiteral(`'open`)).toThrow(/unterminated/);
    expect(() => parsePythonLiteral(`[1 2]`)).toThrow();
  });
});

describe('BEAM', () => {
  it('reads time anchors and strips position markers', () => {
    expect(parseBeamAnchor('March-15-2024')?.toISOString()).toBe('2024-03-15T00:00:00.000Z');
    expect(parseBeamAnchor('not a date')).toBeUndefined();
    expect(stripBeamMarker('Plan my week ->-> 1,1')).toBe('Plan my week');
  });

  it('turns a row into turns and rubric questions', () => {
    const conversation = beamConversation(
      {
        conversation_id: '7',
        chat: [
          [
            { id: 0, role: 'user', content: 'Hi ->-> 1,1', time_anchor: 'March-15-2024' },
            { id: 1, role: 'assistant', content: 'Hello', time_anchor: null },
          ],
        ],
        probing_questions: `{'knowledge_update': [{'question': 'Latency?', 'answer': '250ms', 'rubric': ['says 250ms'], 'source_chat_ids': [1, 9]}]}`,
      },
      '100K'
    );
    expect(conversation).toMatchObject({ id: '100K:7', dataset: 'beam-100k' });
    expect(conversation.turns.map((t) => t.content)).toEqual(['Hi', 'Hello']);
    expect(conversation.turns[1].at?.toISOString()).toBe('2024-03-15T00:00:00.000Z');
    expect(conversation.questions).toEqual([
      {
        id: '7:knowledge_update:0',
        category: 'knowledge_update',
        question: 'Latency?',
        answer: '250ms',
        scoring: { kind: 'beam-rubric', rubric: ['says 250ms'] },
        evidence: ['Hello'],
      },
    ]);
  });
});

describe('LongMemEval', () => {
  it('reads its dates', () => {
    expect(parseLongMemEvalDate('2023/05/20 (Sat) 02:21')?.toISOString()).toBe(
      '2023-05-20T02:21:00.000Z'
    );
  });

  it('dates each session, marks evidence and flags abstention questions', () => {
    const conversation = longMemEvalConversation({
      question_id: 'q1_abs',
      question_type: 'multi-session',
      question: 'How many?',
      answer: 3,
      question_date: '2023/06/01 (Thu) 10:00',
      haystack_dates: ['2023/05/20 (Sat) 02:21'],
      haystack_sessions: [
        [
          { role: 'user', content: 'I bought 3 bikes.', has_answer: true },
          { role: 'assistant', content: 'Nice.' },
        ],
      ],
    });
    expect(conversation.turns.map((turn) => turn.content)).toEqual([
      '[2023/05/20 (Sat) 02:21] I bought 3 bikes.',
      '[2023/05/20 (Sat) 02:21] Nice.',
    ]);
    expect(conversation.questions[0]).toMatchObject({
      category: 'multi-session (abstention)',
      answer: '3',
      askedOn: '2023/06/01 (Thu) 10:00',
      evidence: ['I bought 3 bikes.'],
      scoring: { kind: 'longmemeval', questionType: 'multi-session', abstention: true },
    });
  });
});

describe('MemoryAgentBench conflicts', () => {
  it('cuts facts at line ends', () => {
    expect(chunkFacts('0. a\n1. b\n2. c', 9)).toEqual(['0. a\n1. b', '2. c']);
  });

  it('asks every question with the newer-fact rule', () => {
    const conversation = conflictConversation({
      context: '0. X lives in Paris.\n1. X lives in Rome.',
      questions: ['Where does X live?'],
      answers: [['Rome']],
      metadata: { qa_pair_ids: ['factconsolidation_sh_6k_no0'] },
    });
    expect(conversation.id).toBe('factconsolidation_sh_6k');
    expect(conversation.protocol).toBe(CONFLICT_INSTRUCTION);
    expect(conversation.questions[0]).toMatchObject({
      category: 'single-hop',
      question: 'Where does X live?',
      scoring: { kind: 'substring', answers: ['Rome'] },
    });
  });
});

describe('LongMemEval-V2', () => {
  const trajectory = {
    id: 't1',
    environment: 'workarena',
    goal: 'Open incidents',
    outcome: 'success',
    start_url: 'https://x/start',
    states: [
      {
        state_index: 0,
        url: 'https://x/a',
        action: null,
        thought: null,
        accessibility_tree: 'x'.repeat(TREE_CHARS + 10),
      },
      {
        state_index: 1,
        url: 'https://x/b',
        action: 'click(1)',
        thought: 'go',
        accessibility_tree: 'tree',
      },
    ],
  };

  it('turns a trajectory into log notes, one per step, the trees cut', () => {
    const turns = trajectoryTurns(trajectory);
    const session = '[Log of an earlier session in workarena, task: Open incidents (success)]';
    expect(turns.every((turn) => turn.role === 'user')).toBe(true);
    expect(turns[0].content).toBe(`${session}\nStarted at https://x/start.`);
    expect(turns[1].content.endsWith('[...]')).toBe(true);
    expect(turns.at(-1)?.content).toBe(
      `${session}\nStep 1 at https://x/b\nThought: go\nAction: click(1)\nPage:\ntree`
    );
  });

  it('groups questions by shared haystack and leaves out questions with a screenshot', () => {
    const conversations = lmeV2Conversations(
      [
        {
          id: 'q1',
          domain: 'enterprise',
          question_type: 'procedure',
          question: 'Q1',
          image: null,
          answer: 'A',
          eval_function: 'mc_choice_match',
        },
        {
          id: 'q2',
          domain: 'enterprise',
          question_type: 'procedure',
          question: 'Q2',
          image: null,
          answer: 'B',
          eval_function: 'mc_choice_match',
        },
        {
          id: 'q3',
          domain: 'enterprise',
          question_type: 'procedure',
          question: 'Q3',
          image: 'q3.png',
          answer: 'C',
          eval_function: 'mc_choice_match',
        },
      ],
      { q1: ['t1'], q2: ['t1'], q3: ['t1'] },
      new Map([['t1', trajectory]])
    );
    expect(conversations).toHaveLength(1);
    expect(conversations[0].questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(conversations[0].id).toBe('enterprise-0');
  });
});

describe('LoCoMo', () => {
  it('keeps answerable questions with their evidence and dates sessions', () => {
    const conversation = locomoConversation({
      sample_id: 's1',
      conversation: {
        speaker_a: 'Ann',
        speaker_b: 'Bo',
        session_1_date_time: '1:56 pm on 8 May, 2023',
        session_1: [
          { speaker: 'Ann', dia_id: 'D1:1', text: 'I ran a race.' },
          { speaker: 'Bo', dia_id: 'D1:2', text: 'Great!' },
        ],
      },
      qa: [
        { question: 'What did Ann run?', answer: 'a race', evidence: ['D1:1'], category: 4 },
        { question: 'Adversarial?', evidence: ['D1:2'], category: 5 },
      ],
    });
    expect(conversation.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(conversation.turns.map((t) => t.content)).toEqual([
      '[1:56 pm on 8 May, 2023] Ann: I ran a race.',
      '[1:56 pm on 8 May, 2023] Bo: Great!',
    ]);
    expect(conversation.questions).toEqual([
      expect.objectContaining({ category: 'single-hop', evidence: ['Ann: I ran a race.'] }),
    ]);
  });
});
