import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import {
  bridgePaths,
  channelRoute,
  inboxRoute,
  personRoutes,
  type BridgeAdapter,
  type ChannelPersonRoute,
  type FactBoard,
  type PersonRoute,
  type RightsJudge,
} from '@cogitator-ai/bridge';
import { memoryBoard } from '@cogitator-ai/bridge/memory';
import { recipeAdapter } from '@cogitator-ai/bridge/recipes';
import { settingsRights } from '@cogitator-ai/bridge/rights';
import { telegramChannel } from '@cogitator-ai/channels';
import { experimental_FileInboxStore, experimental_Inbox } from '@cogitator-ai/core';
import type { Channel } from '@cogitator-ai/types';
import { FileCheckpointStore } from '@cogitator-ai/workflows';
import { UsageError } from './cli.js';

/** The token of the Telegram bot the bridge reaches the person with. */
export const BRIDGE_TELEGRAM_TOKEN_ENV = 'COGITATOR_BRIDGE_TELEGRAM_TOKEN';
/** The Telegram chat of the person: letters go there, and only it is listened to. */
export const BRIDGE_TELEGRAM_CHAT_ENV = 'COGITATOR_BRIDGE_TELEGRAM_CHAT';
/** Who in that chat may answer, as Telegram user ids separated by commas. Everybody in it by default. */
export const BRIDGE_TELEGRAM_USERS_ENV = 'COGITATOR_BRIDGE_TELEGRAM_USERS';

/** The file of the bridge's inbox, in the folder of the bridge. */
export const BRIDGE_INBOX_FILE = 'inbox.json';

/** The file of the board of facts, in the folder of the bridge. */
export const BRIDGE_MEMORY_FILE = 'memory.db';

/**
 * The board of facts of this machine: what agents and the person told the bridge to remember, by
 * project, kept in a SQLite file of its own next to the bridge's database, for its owner only.
 * Undefined when it cannot be opened: the dispatcher then runs without one, and `onError` hears why.
 */
export async function bridgeBoard(
  env: NodeJS.ProcessEnv = process.env,
  settings: Pick<BridgePersonSettings, 'home' | 'onError'> = {}
): Promise<FactBoard | undefined> {
  try {
    const paths = bridgePaths({ ...(settings.home && { home: settings.home }), env });
    mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    const file = join(paths.home, BRIDGE_MEMORY_FILE);
    closeSync(openSync(file, 'a', 0o600));
    for (const kept of [file, `${file}-wal`, `${file}-shm`]) {
      if (existsSync(kept)) chmodSync(kept, 0o600);
    }
    return await memoryBoard({ store: file });
  } catch (error) {
    settings.onError?.(
      new Error(
        `The board of facts could not be opened, so nothing is remembered: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    );
    return undefined;
  }
}

/** The folder of the checkpoints of the recipes that run, in the folder of the bridge. */
export const BRIDGE_RECIPES_DIR = 'recipes';

/**
 * The conductor of this machine's bridge: it carries the jobs that name a recipe out (`build`,
 * `review`), and keeps the place of each run in a folder next to the bridge's database, so a
 * recipe goes on where it was when the dispatcher is restarted. Undefined when it cannot be set
 * up: the dispatcher then runs without recipes, and `onError` hears why.
 */
export function bridgeConductor(
  env: NodeJS.ProcessEnv = process.env,
  settings: Pick<BridgePersonSettings, 'home' | 'onError'> = {}
): BridgeAdapter | undefined {
  try {
    const paths = bridgePaths({ ...(settings.home && { home: settings.home }), env });
    const folder = join(paths.home, BRIDGE_RECIPES_DIR);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    return recipeAdapter({
      checkpoints: new FileCheckpointStore(folder),
      ...(settings.onError && { onError: settings.onError }),
    });
  } catch (error) {
    settings.onError?.(
      new Error(
        `The recipes of the bridge could not be set up, so it carries none out: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    );
    return undefined;
  }
}

export interface BridgePersonSettings {
  /** The folder of the bridge, when a flag named one */
  home?: string;
  /** Hears what a route could not do */
  onError?: (error: Error) => void;
  /** Makes the Telegram channel of a token, `telegramChannel` by default */
  telegram?: (token: string) => Channel;
}

/** How the dispatcher of the command line reaches the person, and whose word a call needs. */
export interface BridgePerson {
  rights: RightsJudge;
  person: PersonRoute;
  /** What the person is reached by, for the lines `serve` prints */
  reachedBy: string[];
  /** Starts what has to listen, once the dispatcher runs */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The routes to the person the command line sets up: always the inbox file in the folder of the
 * bridge, and a Telegram chat when `COGITATOR_BRIDGE_TELEGRAM_TOKEN` and
 * `COGITATOR_BRIDGE_TELEGRAM_CHAT` name one. Rights are read from the permission settings of
 * each job's project.
 *
 * @throws UsageError when only one of the two Telegram variables is set
 */
export function bridgePerson(
  env: NodeJS.ProcessEnv = process.env,
  settings: BridgePersonSettings = {}
): BridgePerson {
  const paths = bridgePaths({ ...(settings.home && { home: settings.home }), env });
  const inboxFile = join(paths.home, BRIDGE_INBOX_FILE);
  const inbox = new experimental_Inbox({ store: new experimental_FileInboxStore(inboxFile) });
  const routes: PersonRoute[] = [inboxRoute(inbox)];
  const reachedBy = ['cogitator bridge asks'];

  const token = env[BRIDGE_TELEGRAM_TOKEN_ENV]?.trim();
  const chatId = env[BRIDGE_TELEGRAM_CHAT_ENV]?.trim();
  let chat: ChannelPersonRoute | undefined;
  if (token && chatId) {
    const userIds = env[BRIDGE_TELEGRAM_USERS_ENV]?.split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    chat = channelRoute({
      channel: (settings.telegram ?? ((given) => telegramChannel({ token: given })))(token),
      chatId,
      ...(userIds && userIds.length > 0 && { userIds }),
      ...(settings.onError && { onError: settings.onError }),
    });
    routes.push(chat);
    reachedBy.push(`Telegram chat ${chatId}`);
  } else if (token || chatId) {
    throw new UsageError(
      `Telegram needs both ${BRIDGE_TELEGRAM_TOKEN_ENV} and ${BRIDGE_TELEGRAM_CHAT_ENV}`,
      [`Set the one that is missing, or unset the other to do without Telegram`]
    );
  }

  return {
    rights: settingsRights(),
    person: personRoutes(routes),
    reachedBy,
    start: async () => {
      await chat?.start();
    },
    stop: async () => {
      await chat?.stop();
    },
  };
}
