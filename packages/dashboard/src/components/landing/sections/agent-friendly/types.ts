/** One line of the agent terminal demo; `agent` and `command` lines are typed, the rest stream in. */
export type TerminalLine =
  | {
      kind: 'agent' | 'command' | 'heading' | 'quote' | 'out' | 'note' | 'blank' | 'vox';
      text: string;
    }
  | {
      kind: 'entry';
      text: string;
      title: string;
      url: string;
      description?: string;
      highlight: boolean;
    };
