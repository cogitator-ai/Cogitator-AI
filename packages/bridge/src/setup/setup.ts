/** What `install` and `uninstall` are asked to set up or undo. */
export interface SetupContext {
  /**
   * The checkout the sessions work in, an absolute path. A linked git worktree is set up on its
   * own: a harness reads the settings of the folder a session is opened in, not of the main
   * checkout
   */
  project: string;
  /**
   * `project`: for this person in this project only. `user`: for this person in every project.
   * A path of this machine never goes into a file the project shares: what names one is kept
   * where only this person has it
   */
  scope: 'project' | 'user';
}

export interface InstallContext extends SetupContext {
  /** Whether the notes of the bridge go into the instructions file the sessions read */
  notes: boolean;
  /**
   * Whether the notes let a session a person opened carry out a job of another agent without
   * asking the person first
   */
  takeJobs: boolean;
  /** Whether sessions may call the bridge's tools without a permission prompt, where the harness has one */
  allowTools: boolean;
}

/**
 * One change to the setup of a harness, as a person is shown it before anything is written.
 * A step exists only when it changes something: a harness that is set up already has none.
 */
export interface SetupStep {
  /** What changes, in a few words */
  title: string;
  /** The change itself, a line each: the command that runs, or what a file gains or loses */
  lines: string[];
  /** Makes the change. Rejects with what went wrong */
  apply(): Promise<void>;
}

/** How one harness is given the bridge for the sessions a person opens, and how that is undone. */
export interface AdapterSetup {
  /**
   * The steps that give the sessions of a project the bridge: its tools, the hooks the harness
   * needs to wake a session and to tell the tools who calls, and the notes. Empty when
   * everything is in place.
   *
   * @throws Error when the harness is not installed, or what it keeps cannot be read
   */
  install(context: InstallContext): Promise<SetupStep[]>;
  /** The steps that take all of it away again. Empty when nothing of the bridge is there */
  uninstall(context: SetupContext): Promise<SetupStep[]>;
}
