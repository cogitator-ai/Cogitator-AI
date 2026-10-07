import { memo, isValidElement, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { CopyButton } from './common';

/** The languages agents write most, a fraction of the size of every grammar. */
const LANGUAGES = {
  bash,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
};

const ALIASES = { bash: ['sh', 'zsh'], xml: ['html', 'svg'], markdown: ['md'] };

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function languageOf(code: ReactNode): string | undefined {
  if (!isValidElement<{ className?: string }>(code)) return undefined;
  return /language-([\w+-]+)/.exec(code.props.className ?? '')?.[1];
}

const components: Components = {
  pre: ({ children }) => {
    const code = Array.isArray(children) ? (children[0] as ReactElement) : children;
    const language = languageOf(code);
    return (
      <div className="codeblock">
        <div className="codeblock-head">
          <span>{language ?? 'text'}</span>
          <CopyButton value={textOf(code).replace(/\n$/, '')} label="Copy code" />
        </div>
        <pre>{children}</pre>
      </div>
    );
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
};

/**
 * Model output as GitHub-flavored Markdown with highlighted code. Raw HTML in
 * the text is never rendered.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          [rehypeHighlight, { detect: false, languages: LANGUAGES, aliases: ALIASES }],
        ]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
