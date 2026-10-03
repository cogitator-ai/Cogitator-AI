import { notFound } from 'next/navigation';
import { renderRecipeOgImage, renderSectionOgImage } from '@/app/cookbook/social-card';
import { findSection, findSectionRecipe, recipeEntries } from '@/app/cookbook/routes';
import { COOKBOOK_OG_IMAGE_FILE } from '@/app/cookbook/seo';
import { sections } from '@/app/cookbook/recipes';

export const dynamic = 'force-static';

export const dynamicParams = false;

interface RouteProps {
  params: Promise<{ slug: string[] }>;
}

/** Social card of one cookbook section or recipe, prerendered at build time for each of them. */
export async function GET(_request: Request, { params }: RouteProps) {
  const { slug } = await params;
  if (slug.at(-1) !== COOKBOOK_OG_IMAGE_FILE) notFound();

  const [sectionId, recipeId, ...rest] = slug.slice(0, -1);
  if (!sectionId || rest.length > 0) notFound();

  if (!recipeId) {
    const section = findSection(sectionId);
    if (!section) notFound();
    return renderSectionOgImage(section);
  }

  const entry = findSectionRecipe(sectionId, recipeId);
  if (!entry) notFound();
  return renderRecipeOgImage(entry.section, entry.recipe);
}

export function generateStaticParams(): { slug: string[] }[] {
  return [
    ...sections.map((section) => ({ slug: [section.id, COOKBOOK_OG_IMAGE_FILE] })),
    ...recipeEntries.map(({ section, recipe }) => ({
      slug: [section.id, recipe.id, COOKBOOK_OG_IMAGE_FILE],
    })),
  ];
}
