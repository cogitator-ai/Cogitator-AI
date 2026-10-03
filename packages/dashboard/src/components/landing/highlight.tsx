import { highlight } from 'fumadocs-core/highlight';
import type { ReactNode } from 'react';

export type CodeLang = 'ts' | 'tsx' | 'bash' | 'yaml' | 'json' | 'text';

/** Server-side Shiki highlighting for landing snippets; the window supplies the background. */
export function highlightCode(code: string, lang: CodeLang = 'ts'): Promise<ReactNode> {
  return highlight(code.trim(), {
    lang,
    theme: 'vitesse-dark',
    components: {
      pre: ({ style: _style, ...props }) => <pre {...props} />,
    },
  });
}
