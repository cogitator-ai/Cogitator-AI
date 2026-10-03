import { COOKBOOK_URL } from '@/lib/site';
import { findRecipe, sections, type Recipe, type Section } from './recipes';

export interface RecipeEntry {
  section: Section;
  recipe: Recipe;
}

/** Every recipe in reading order, with the section it belongs to. */
export const recipeEntries: RecipeEntry[] = sections.flatMap((section) =>
  section.recipes.map((recipe) => ({ section, recipe }))
);

export function findSection(id: string): Section | undefined {
  return sections.find((section) => section.id === id);
}

/** A recipe looked up by both route segments; `undefined` when it is not in that section. */
export function findSectionRecipe(sectionId: string, recipeId: string): RecipeEntry | undefined {
  const section = findSection(sectionId);
  const recipe = section?.recipes.find((candidate) => candidate.id === recipeId);
  return section && recipe ? { section, recipe } : undefined;
}

export function sectionPath(section: Pick<Section, 'id'>): string {
  return `${COOKBOOK_URL}/${section.id}`;
}

export function recipePath(section: Pick<Section, 'id'>, recipe: Pick<Recipe, 'id'>): string {
  return `${COOKBOOK_URL}/${section.id}/${recipe.id}`;
}

/** The recipes before and after this one in reading order. */
export function recipeNeighbours(recipeId: string): {
  previous?: RecipeEntry;
  next?: RecipeEntry;
} {
  const index = recipeEntries.findIndex((entry) => entry.recipe.id === recipeId);
  if (index === -1) return {};
  return { previous: recipeEntries[index - 1], next: recipeEntries[index + 1] };
}

/** The id the hash-routed cookbook used for its overview, as in `/cookbook#overview`. */
const LEGACY_OVERVIEW_HASH = 'overview';

/**
 * Where a link from the hash-routed cookbook now points: `#agents` was a section, `#approvals` a
 * recipe and `#overview` the overview. `undefined` for any other hash.
 */
export function legacyHashPath(hash: string): string | undefined {
  if (hash === LEGACY_OVERVIEW_HASH) return COOKBOOK_URL;
  const section = findSection(hash);
  if (section) return sectionPath(section);
  const found = findRecipe(hash);
  return found ? recipePath(found.section, found.recipe) : undefined;
}
