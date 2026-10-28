/**
 * The app-server on stdio for the `app-server` stage, which spawns this file and drives it with
 * the generated client. The second process of the stage opens the same SQLite file.
 */
import {
  readSessionFixtureEnv,
  serveAppServerFixture,
} from '../../src/stages/protocols/session-fixtures.ts';

await serveAppServerFixture(readSessionFixtureEnv(process.env));
