import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { jsonLd } from '@/lib/seo';
import { RecipeView } from '../../components/views';
import { findSectionRecipe, recipeEntries } from '../../routes';
import { recipeMetadata, recipeStructuredData } from '../../seo';

export const dynamicParams = false;

interface PageProps {
  params: Promise<{ section: string; recipe: string }>;
}

export function generateStaticParams(): { section: string; recipe: string }[] {
  return recipeEntries.map(({ section, recipe }) => ({ section: section.id, recipe: recipe.id }));
}

async function entryFor(params: PageProps['params']) {
  const { section, recipe } = await params;
  const entry = findSectionRecipe(section, recipe);
  if (!entry) notFound();
  return entry;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { section, recipe } = await entryFor(params);
  return recipeMetadata(section, recipe);
}

export default async function CookbookRecipePage({ params }: PageProps) {
  const { section, recipe } = await entryFor(params);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(recipeStructuredData(section, recipe)) }}
      />
      <RecipeView section={section} recipe={recipe} />
    </>
  );
}
