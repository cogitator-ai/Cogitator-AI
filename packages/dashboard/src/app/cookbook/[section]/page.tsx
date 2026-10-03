import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { jsonLd } from '@/lib/seo';
import { SectionView } from '../components/views';
import { sections } from '../recipes';
import { findSection } from '../routes';
import { sectionMetadata, sectionStructuredData } from '../seo';

export const dynamicParams = false;

interface PageProps {
  params: Promise<{ section: string }>;
}

export function generateStaticParams(): { section: string }[] {
  return sections.map((section) => ({ section: section.id }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const section = findSection((await params).section);
  if (!section) notFound();
  return sectionMetadata(section);
}

export default async function CookbookSectionPage({ params }: PageProps) {
  const section = findSection((await params).section);
  if (!section) notFound();

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(sectionStructuredData(section)) }}
      />
      <SectionView section={section} />
    </>
  );
}
