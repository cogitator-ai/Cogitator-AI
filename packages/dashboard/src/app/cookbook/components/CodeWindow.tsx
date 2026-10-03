import { highlight } from 'fumadocs-core/highlight';
import { CodeBody, Window, cx } from '@/components/landing/ui';
import type { CodeSample } from '../recipes';
import { CopyButton } from './CopyButton';

export type CodeLanguage = CodeSample['language'];

/** Server-side Shiki highlighting in the landing's theme; the window supplies the background. */
function highlightSnippet(code: string, language: CodeLanguage) {
  return highlight(code, {
    lang: language,
    theme: 'vitesse-dark',
    components: {
      pre: ({ style: _style, ...props }) => <pre {...props} />,
    },
  });
}

/** A cogitator terminal (code variant) holding a highlighted, copyable snippet. */
export async function CodeWindow({
  code,
  language,
  title,
  className,
}: {
  code: string;
  language: CodeLanguage;
  title: string;
  className?: string;
}) {
  const highlighted = await highlightSnippet(code, language);

  return (
    <Window
      title={title}
      aside={<CopyButton text={code} label={title} />}
      className={cx('my-5', className)}
    >
      <CodeBody className="leading-[1.7]">{highlighted}</CodeBody>
    </Window>
  );
}
