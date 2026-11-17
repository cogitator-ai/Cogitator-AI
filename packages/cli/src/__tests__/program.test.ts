import { describe, it, expect } from 'vitest';
import { COMMAND_ENTRIES, commandEntriesFor, createProgram } from '../program.js';

const namesOf = (args?: readonly string[]): string[] =>
  commandEntriesFor(args).map((entry) => entry.names[0]);
const ALL = COMMAND_ENTRIES.map((entry) => entry.names[0]);

describe('the commands of the program', () => {
  it('are listed under the name and the aliases each one declares', async () => {
    for (const entry of COMMAND_ENTRIES) {
      const command = await entry.load();
      expect([command.name(), ...command.aliases()]).toEqual([...entry.names]);
    }
    const names = COMMAND_ENTRIES.flatMap((entry) => entry.names);
    expect(new Set(names).size).toBe(names.length);
  });

  it('are all in the program built without a command line, in the order of the list', async () => {
    const program = await createProgram();
    expect(program.commands.map((command) => command.name())).toEqual(ALL);
  });

  it('are loaded one at a time for a line that starts with the name or an alias of one', async () => {
    expect(namesOf(['models', '--json'])).toEqual(['models']);
    expect(namesOf(['ps'])).toEqual(['status']);
    expect(namesOf(['bridge', 'mcp', '--home', '/tmp/bridge'])).toEqual(['bridge']);

    const program = await createProgram(['plugins', 'list']);
    expect(program.commands.map((command) => command.name())).toEqual(['plugin']);
  });

  it('are not loaded for the version flag', () => {
    expect(namesOf(['--version'])).toEqual([]);
    expect(namesOf(['-V'])).toEqual([]);
  });

  it('are all loaded for a line that may show or suggest any of them', () => {
    expect(namesOf(undefined)).toEqual(ALL);
    expect(namesOf([])).toEqual(ALL);
    expect(namesOf(['--help'])).toEqual(ALL);
    expect(namesOf(['help', 'deploy'])).toEqual(ALL);
    expect(namesOf(['deplyo'])).toEqual(ALL);
    expect(namesOf(['--nope', 'deploy'])).toEqual(ALL);
  });
});
