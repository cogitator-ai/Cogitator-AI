/**
 * An ACP agent on stdio for the `acp` stage, which launches this file through
 * `AcpAgentProvider` and drives it as an external agent of a `SessionHost`.
 */
import {
  readSessionFixtureEnv,
  serveAcpFixture,
} from '../../src/stages/protocols/session-fixtures.ts';

await serveAcpFixture(readSessionFixtureEnv(process.env));
