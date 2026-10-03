import { jsonLd } from '@/lib/seo';
import { CookbookOverview } from './components/views';
import { overviewMetadata, overviewStructuredData } from './seo';

export const metadata = overviewMetadata;

export default function CookbookPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(overviewStructuredData()) }}
      />
      <CookbookOverview />
    </>
  );
}
