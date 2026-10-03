export type Difficulty = 'easy' | 'medium' | 'advanced';

export interface CodeSample {
  title: string;
  language: 'typescript' | 'bash' | 'jsonc';
  code: string;
}

export interface RecipeNote {
  type: 'info' | 'warning' | 'tip';
  /** Plain text; spans in backticks render as inline code. */
  text: string;
}

export interface DocLink {
  /** Path of a page under /docs. */
  href: string;
  label: string;
}

export interface Recipe {
  id: string;
  title: string;
  difficulty: Difficulty;
  time: string;
  /** The problem the recipe solves, in one or two sentences. */
  problem: string;
  points: string[];
  /** File name the snippet is saved as; also used in the run command. */
  file: string;
  /** Complete, type-checked source of the recipe. */
  code: string;
  install: string;
  /** Extra one-time setup, such as starting a database or installing browsers. */
  setup?: string;
  /** Environment variables the recipe reads; "(optional)" marks ones it can do without. */
  env: string[];
  /** Command that runs the snippet on its own. */
  run: string;
  /** Command that runs the full example from a clone of the repository. */
  repoRun?: string;
  runNote?: string;
  extra?: CodeSample[];
  notes?: RecipeNote[];
  /** Path of the example under examples/ in the repository. */
  example?: string;
  docs: DocLink[];
}

export interface Section {
  id: string;
  title: string;
  icon: string;
  description: string;
  recipes: Recipe[];
}
