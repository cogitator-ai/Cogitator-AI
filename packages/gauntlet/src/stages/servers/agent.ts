/**
 * The agent every server stage exposes. Bun and Deno fixtures import this file directly, so it
 * must only import packages (no relative imports) to stay loadable by every runtime.
 */
import { Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

export const SERVER_AGENT = 'concierge';
export const SERVER_AGENT_DESCRIPTION = 'Looks up locker door codes of the building';
export const SERVER_AGENT_INSTRUCTIONS =
  'You are the concierge of an office building. Door codes change daily, so always look them up ' +
  'with the locker_code tool and never guess. Answer in one short sentence that includes the code.';

export const LOCKER = 'B7';
/** Only the tool knows it, so seeing it in an answer proves the tool ran. */
export const LOCKER_CODE = '4719';
export const LOCKER_QUESTION = `What is the door code of locker ${LOCKER}?`;

export const lockerCode = tool({
  name: 'locker_code',
  description: 'Current door code of a locker in the building.',
  parameters: z.object({ locker: z.string().describe('Locker label, for example A1') }),
  execute: async ({ locker }) => ({
    locker,
    code: locker.trim().toUpperCase() === LOCKER ? LOCKER_CODE : 'unknown',
  }),
});

export function createServerAgent(model: string): Agent {
  return new Agent({
    name: SERVER_AGENT,
    description: SERVER_AGENT_DESCRIPTION,
    model,
    instructions: SERVER_AGENT_INSTRUCTIONS,
    tools: [lockerCode],
    maxIterations: 3,
  });
}

/** True when the digits of an answer contain the locker code, whatever the model's formatting. */
export function mentionsLockerCode(text: string): boolean {
  return text.replace(/\D/g, '').includes(LOCKER_CODE);
}

export const SLOW_AGENT = 'archivist';
/** Longer than Bun's default 10 s idle timeout, so the connection stays silent past it. */
export const ARCHIVE_DELAY_MS = 12_000;
export const ARCHIVE_QUESTION = 'Who designed our building? Look it up in the archive.';
/** Only the archive knows it. */
export const ARCHIVE_FACT = 'Halvorsen';

export const archiveLookup = tool({
  name: 'archive_lookup',
  description: 'Searches the paper archive of the building. Slow: takes about 12 seconds.',
  parameters: z.object({ topic: z.string().describe('What to look up') }),
  execute: async ({ topic }) => {
    await new Promise((resolve) => setTimeout(resolve, ARCHIVE_DELAY_MS));
    return { topic, answer: 'The building was designed by the architect Ingrid Halvorsen-Mbeki.' };
  },
});

/** An agent whose answer needs a tool call that keeps the connection silent for 12 s. */
export function createSlowAgent(model: string): Agent {
  return new Agent({
    name: SLOW_AGENT,
    description: 'Answers questions from the paper archive of the building',
    model,
    instructions:
      'You answer questions about the building from its archive. Always use archive_lookup and ' +
      'answer in one short sentence.',
    tools: [archiveLookup],
    maxIterations: 3,
  });
}

/** The agents every server exposes, by name. */
export function createServerAgents(model: string): Record<string, Agent> {
  return { [SERVER_AGENT]: createServerAgent(model), [SLOW_AGENT]: createSlowAgent(model) };
}
