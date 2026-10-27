import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isFile, isInside } from './files';
import { globMatches } from './glob';
import { JUDGE_VOTES, type PluginEvalJudge } from './judge';
import { namesCall } from './tools';
import {
  parseTranscript,
  readableTranscript,
  traceLines,
  type TranscriptEntry,
} from './transcript';
import type {
  PluginEvalGrader,
  PluginEvalGraderResult,
  PluginEvalMockCall,
  PluginEvalTarget,
  PluginEvalToolCall,
  PluginEvalToolMatcher,
  PluginEvalVote,
} from './types';

/** What one run left for its graders */
export interface RunCapture {
  prompt: string;
  lastMessage: string;
  entries: TranscriptEntry[];
  toolCalls: PluginEvalToolCall[];
  mockCalls: PluginEvalMockCall[];
  filesCreated: string[];
  workspaceRoot: string;
  caseDir: string;
}

/** How many messages of a trace an `llm` judge sees from its start and from its end */
const JUDGED_TRACE_ENDS = 12;
const BINARY_SNIFF = 8192;

type Content = { text: string; binary?: boolean } | { missing: string };

function targetLabel(target: PluginEvalTarget): string {
  return typeof target === 'string' ? target : `file ${target.path}`;
}

function contentOf(target: PluginEvalTarget, capture: RunCapture, forJudge: boolean): Content {
  if (typeof target === 'object') {
    const path = resolve(capture.workspaceRoot, target.path);
    if (!isInside(capture.workspaceRoot, path) || !isFile(path)) {
      return { missing: `the file ${target.path} does not exist in the workspace` };
    }
    const bytes = readFileSync(path);
    const binary = bytes.subarray(0, BINARY_SNIFF).includes(0);
    return { text: bytes.toString('utf8'), ...(binary && { binary: true }) };
  }
  switch (target) {
    case 'last_message':
      return { text: capture.lastMessage };
    case 'files':
      return { text: capture.filesCreated.join('\n') };
    case 'mock_calls':
      return { text: capture.mockCalls.map((call) => JSON.stringify(call)).join('\n') };
    case 'trace': {
      const lines = traceLines(capture.entries);
      if (!forJudge || lines.length <= JUDGED_TRACE_ENDS * 2) return { text: lines.join('\n') };
      const left = lines.length - JUDGED_TRACE_ENDS * 2;
      return {
        text: [
          ...lines.slice(0, JUDGED_TRACE_ENDS),
          `... ${left} message${left === 1 ? '' : 's'} left out ...`,
          ...lines.slice(-JUDGED_TRACE_ENDS),
        ].join('\n'),
      };
    }
  }
}

function excerpt(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 30);
  const snippet = text.slice(start, at + Math.max(length, 1) + 30).replace(/\s+/g, ' ');
  return `${start > 0 ? '...' : ''}${snippet}${at + length + 30 < text.length ? '...' : ''}`;
}

function matchesInput(call: PluginEvalToolCall, inputMatch: string | undefined): boolean {
  return inputMatch === undefined || new RegExp(inputMatch).test(JSON.stringify(call.input));
}

function firstIndex(calls: readonly PluginEvalToolCall[], matcher: PluginEvalToolMatcher): number {
  return calls.findIndex(
    (call) => namesCall(matcher.tool, call) && matchesInput(call, matcher.inputMatch)
  );
}

function matcherText(matcher: PluginEvalToolMatcher): string {
  return matcher.inputMatch === undefined
    ? matcher.tool
    : `${matcher.tool} /${matcher.inputMatch}/`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

type Verdict = Pick<PluginEvalGraderResult, 'passed' | 'explanation'> &
  Partial<Pick<PluginEvalGraderResult, 'votes' | 'evidence' | 'costUsd'>>;

/** Whether a grader calls the judge, and so costs something */
export function isPaidGrader(grader: PluginEvalGrader): boolean {
  return grader.type === 'llm' || grader.type === 'baseline';
}

/** Applies one grader to a run */
export async function grade(
  grader: PluginEvalGrader,
  capture: RunCapture,
  judge: PluginEvalJudge,
  signal?: AbortSignal
): Promise<Verdict> {
  switch (grader.type) {
    case 'regex': {
      const content = contentOf(grader.target, capture, false);
      if ('missing' in content) {
        return grader.match === 'not_contains'
          ? {
              passed: true,
              explanation: `${content.missing}, so it does not contain /${grader.pattern}/`,
            }
          : { passed: false, explanation: content.missing };
      }
      const where = targetLabel(grader.target);
      if (grader.match.startsWith('count:')) {
        const wanted = Number(grader.match.slice('count:'.length));
        const count = [...content.text.matchAll(new RegExp(grader.pattern, `${grader.flags}g`))]
          .length;
        return {
          passed: count === wanted,
          explanation: `/${grader.pattern}/${grader.flags} matched ${plural(count, 'time')} in ${where}, ${wanted} wanted`,
        };
      }
      const found = new RegExp(grader.pattern, grader.flags).exec(content.text);
      const contains = grader.match === 'contains';
      if (found) {
        return {
          passed: contains,
          explanation: `/${grader.pattern}/${grader.flags} found in ${where}: "${excerpt(content.text, found.index, found[0].length)}"`,
        };
      }
      return {
        passed: !contains,
        explanation: `/${grader.pattern}/${grader.flags} not found in ${where}`,
      };
    }
    case 'tool_used': {
      const count = capture.toolCalls.filter(
        (call) => namesCall(grader.tool, call) && matchesInput(call, grader.inputMatch)
      ).length;
      const passed = count >= grader.min && (grader.max === undefined || count <= grader.max);
      const bounds =
        grader.max === undefined
          ? `at least ${grader.min}`
          : grader.min === grader.max
            ? `exactly ${grader.min}`
            : `${grader.min} to ${grader.max}`;
      const filter =
        grader.inputMatch === undefined ? '' : ` with input matching /${grader.inputMatch}/`;
      return {
        passed,
        explanation: `${grader.tool} called ${plural(count, 'time')}${filter}, ${bounds} wanted`,
      };
    }
    case 'tool_order': {
      const before = firstIndex(capture.toolCalls, grader.before);
      const after = firstIndex(capture.toolCalls, grader.after);
      if (before === -1)
        return { passed: false, explanation: `${matcherText(grader.before)} was not called` };
      if (after === -1)
        return { passed: false, explanation: `${matcherText(grader.after)} was not called` };
      return {
        passed: before < after,
        explanation: `${matcherText(grader.before)} first at call ${before + 1}, ${matcherText(grader.after)} first at call ${after + 1}`,
      };
    }
    case 'file_exists': {
      const matching = capture.filesCreated.filter((path) => globMatches(grader.path, path));
      if (grader.exists) {
        return matching.length > 0
          ? { passed: true, explanation: `created ${matching.slice(0, 5).join(', ')}` }
          : { passed: false, explanation: `no file created during the run matches ${grader.path}` };
      }
      return matching.length === 0
        ? { passed: true, explanation: `no file created during the run matches ${grader.path}` }
        : { passed: false, explanation: `created ${matching.slice(0, 5).join(', ')}, none wanted` };
    }
    case 'llm': {
      const content = contentOf(grader.focus, capture, true);
      if ('missing' in content) return { passed: false, explanation: content.missing };
      if (content.binary) {
        return {
          passed: false,
          explanation: `${targetLabel(grader.focus)} is a binary file, which the judge cannot read: write it out as text and grade that`,
        };
      }
      const answer = await judge.ask(
        {
          kind: 'llm',
          criteria: grader.criteria,
          evidence: content.text,
          prompt: capture.prompt,
        },
        signal
      );
      return {
        ...tally(answer.votes),
        votes: answer.votes,
        evidence: content.text,
        costUsd: answer.costUsd,
      };
    }
    case 'baseline': {
      const file = join(capture.caseDir, grader.baselineFile);
      const reference = parseTranscript(readFileSync(file, 'utf8'));
      if ('error' in reference) {
        return { passed: false, explanation: `${grader.baselineFile}: ${reference.error}` };
      }
      const run = readableTranscript(capture.entries);
      const answer = await judge.ask(
        {
          kind: 'baseline',
          criteria: grader.criteria,
          reference: readableTranscript(reference),
          run,
          prompt: capture.prompt,
        },
        signal
      );
      return {
        ...tally(answer.votes),
        votes: answer.votes,
        evidence: run,
        costUsd: answer.costUsd,
      };
    }
  }
}

function tally(votes: readonly PluginEvalVote[]): Verdict {
  const pass = votes.filter((vote) => vote.verdict === 'PASS').length;
  const passed = pass * 2 > JUDGE_VOTES;
  const deciding = votes.find((vote) => (vote.verdict === 'PASS') === passed && vote.reasoning);
  const reason = deciding?.reasoning ?? votes.find((vote) => vote.reasoning)?.reasoning;
  return {
    passed,
    explanation: `${pass} of ${votes.length} votes PASS${reason ? `: ${reason}` : ''}`,
  };
}
