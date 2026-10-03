import { gettingStarted } from './getting-started';
import { agents } from './agents';
import { memory } from './memory';
import { workflows } from './workflows';
import { swarms } from './swarms';
import { reasoning } from './reasoning';
import { safety } from './safety';
import { protocols } from './protocols';
import { servers } from './servers';
import { edge } from './edge';
import { evals } from './evals';
import { voice } from './voice';
import { browser } from './browser';
import { channels } from './channels';
import { infrastructure } from './infrastructure';
import { advanced } from './advanced';
import type { Recipe, Section } from './types';

export type { CodeSample, Difficulty, DocLink, Recipe, RecipeNote, Section } from './types';

export const sections: Section[] = [
  gettingStarted,
  agents,
  memory,
  workflows,
  swarms,
  reasoning,
  safety,
  protocols,
  servers,
  edge,
  evals,
  voice,
  browser,
  channels,
  infrastructure,
  advanced,
];

export const recipeCount = sections.reduce((count, section) => count + section.recipes.length, 0);

export function findRecipe(id: string): { section: Section; recipe: Recipe } | undefined {
  for (const section of sections) {
    const recipe = section.recipes.find((candidate) => candidate.id === id);
    if (recipe) return { section, recipe };
  }
  return undefined;
}
