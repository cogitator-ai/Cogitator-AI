import { renderOgCard } from '@/lib/og-image';
import { SITE_NAME } from '@/lib/site';
import { recipeCount, sections, type Recipe, type Section } from './recipes';

export const COOKBOOK_TITLE = 'Cookbook';

export const COOKBOOK_DESCRIPTION = `${recipeCount} runnable, type-checked recipes for building AI agents with ${SITE_NAME}: tools, memory and RAG, workflows, swarms, MCP and A2A, servers, voice, browser agents and more.`;

export const COOKBOOK_OG_ALT = `${SITE_NAME} Cookbook - ${recipeCount} runnable recipes for AI agents`;

/** Social card of the cookbook, shared by its `opengraph-image` and `twitter-image`. */
export function renderCookbookOgImage() {
  return renderOgCard({
    plaque: 'cookbook',
    status: `${recipeCount} recipes · ${sections.length} sections`,
    title: `The ${SITE_NAME} Cookbook`,
    description:
      'Runnable, type-checked recipes: tools, memory and RAG, workflows, swarms, MCP and A2A, voice and browser agents.',
    prompt: 'npx tsx first-agent.ts',
  });
}

/** Social card of one cookbook section. */
export function renderSectionOgImage(section: Section) {
  const count = section.recipes.length;
  return renderOgCard({
    plaque: 'cookbook',
    status: `Cookbook · ${count} ${count === 1 ? 'recipe' : 'recipes'}`,
    title: section.title,
    description: section.description,
    prompt: `cookbook / ${section.id}`,
  });
}

/** Social card of one recipe: its problem, difficulty, reading time and run command. */
export function renderRecipeOgImage(section: Section, recipe: Recipe) {
  return renderOgCard({
    plaque: 'cookbook',
    status: `Recipe · ${section.title}`,
    title: recipe.title,
    description: recipe.problem.replace(/`/g, ''),
    tags: [recipe.difficulty, recipe.time],
    prompt: recipe.run.split('\n')[0] ?? `cookbook / ${section.id} / ${recipe.id}`,
  });
}
