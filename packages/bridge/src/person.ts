import type { PersonAnswerInput, SendLetterResult } from './inputs.js';
import type { AgentRecord, BridgeJob, PermissionAsk, RenderedLetter, Rights } from './types.js';

/** What a permission request is judged by. */
export interface RightsQuestion {
  job: BridgeJob;
  /** The agent that handed the job over, absent when the bridge does not know it any more */
  delegator: AgentRecord | undefined;
  /** The call the one carrying the job out asks leave for */
  ask: PermissionAsk;
}

/**
 * Says what the rules of the agent that handed a job over make of a call: its own to allow, the
 * person's to decide, or forbidden. The bridge asks it for every permission request that names
 * its call, so an agent carrying a job out never gets leave the one who handed it over does not
 * have. Without a judge every such request is the person's to decide.
 */
export type RightsJudge = (question: RightsQuestion) => Rights | Promise<Rights>;

/** A letter that waits for the person, with the job it is about. */
export interface PersonLetter {
  /** The question or the permission request, with the text its recipient sees */
  letter: RenderedLetter;
  job: BridgeJob;
}

/** Something the person should know that takes no answer through the bridge. */
export interface PersonNotice {
  /** The agent it is about */
  agent: string;
  /** The jobs that stand still because of it */
  jobs: BridgeJob[];
  text: string;
}

/** A letter the person is told of. */
export interface PersonRequest extends PersonLetter {
  /** The person was told of it before and has not answered: this is the reminder */
  again: boolean;
}

/** The bridge as a route to the person calls it. Whoever calls it speaks for the person. */
export interface PersonCalls {
  personAnswer(input: PersonAnswerInput): Promise<SendLetterResult>;
  forPerson(): Promise<PersonLetter[]>;
}

/**
 * How the bridge reaches the person at the machine: an inbox, a chat, whatever shows them a
 * letter that waits for their word. A route that also takes their answer hands it to the bridge
 * it was attached to.
 */
export interface PersonRoute {
  /** The bridge the route serves, given once before anything else */
  attach?(bridge: PersonCalls): void;
  /** A letter waits for the person. Called again, with `again`, when they are reminded */
  ask(request: PersonRequest): void | Promise<void>;
  /** The letter waits no more: it was answered, by the person or not, or its job is over */
  settle(waited: PersonLetter): void | Promise<void>;
  /**
   * Something for the person to know: an agent waits for them at its own window, where only
   * they can answer. A route that does not take notices leaves it out
   */
  tell?(notice: PersonNotice): void | Promise<void>;
}

/**
 * Several routes as one: the person is told on each. A route that fails does not keep the
 * others from being told, and what failed is thrown once all were tried.
 */
export function personRoutes(routes: readonly PersonRoute[]): PersonRoute {
  const each = async (tell: (route: PersonRoute) => void | Promise<void>): Promise<void> => {
    const failed: unknown[] = [];
    for (const route of routes) {
      try {
        await tell(route);
      } catch (error) {
        failed.push(error);
      }
    }
    if (failed.length === 1) throw failed[0];
    if (failed.length > 1) throw new AggregateError(failed, 'Several routes to the person failed');
  };
  return {
    attach: (bridge) => {
      for (const route of routes) route.attach?.(bridge);
    },
    ask: (request) => each((route) => route.ask(request)),
    settle: (waited) => each((route) => route.settle(waited)),
    tell: (notice) => each((route) => route.tell?.(notice)),
  };
}
