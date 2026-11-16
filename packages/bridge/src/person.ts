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

/** A letter that waits for the person. */
export interface PersonRequest {
  /** The question or the permission request, with the text its recipient sees */
  letter: RenderedLetter;
  job: BridgeJob;
  /** The person was told of it before and has not answered: this is the reminder */
  again: boolean;
}

/**
 * How the bridge reaches the person at the machine: an inbox, a chat, whatever shows them a
 * letter that waits for their word. The answer comes back through `BridgeDispatcher.personAnswer`.
 */
export interface PersonRoute {
  /** A letter waits for the person. Called again, with `again`, when they are reminded */
  ask(request: PersonRequest): void | Promise<void>;
  /** The letter waits no more: it was answered, by the person or not, or its job is over */
  settle(letter: RenderedLetter, job: BridgeJob): void | Promise<void>;
}
