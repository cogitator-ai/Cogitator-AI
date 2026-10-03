import { renderOgCard } from '@/lib/og-image';
import { SITE_NAME } from '@/lib/site';
import { recipeCount, sections } from './recipes';

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
