'use client';

import { useEffect, useRef, type Ref } from 'react';
import { Search, X } from 'lucide-react';
import { cx } from '@/components/landing/ui';
import type { Section } from '../recipes';
import { sectionGlyph } from './glyphs';
import { HashLink, type OpenTarget } from './primitives';

const litPlate =
  'border-l-brass/45 bg-[linear-gradient(180deg,#23201a,#15130f)] text-[#a8d9c7] [text-shadow:0_0_6px_rgb(127_212_181/0.3)] shadow-[inset_0_1px_0_rgb(226_197_140/0.12),0_0_12px_-4px_rgb(201_164_92/0.35)]';

/** The recipe search, drawn as a small phosphor screen slot. */
export function SearchSlot({
  value,
  onChange,
  inputRef,
  shortcut,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  /** Keyboard hint shown while the slot is empty; omitted on touch layouts. */
  shortcut?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="readout flex items-center gap-2.5 py-2 pl-3.5 pr-2 transition-[border-color] focus-within:border-[rgb(201_164_92/0.7)]">
      <Search className="size-3.5 shrink-0 text-[#557a6e]" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          if (value) onChange('');
          else event.currentTarget.blur();
        }}
        placeholder="Search recipes"
        aria-label="Search recipes"
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent py-0.5 text-base text-[#c6e6da] caret-[#7fd4b5] outline-none placeholder:text-[#557a6e] md:text-[13.5px] [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="grid size-7 shrink-0 place-items-center rounded text-[#7fa89a] transition-colors hover:text-[#c6e6da] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-l-brass/70"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : (
        shortcut && (
          <kbd className="mr-1 shrink-0 rounded border border-[#7fd4b5]/20 px-1.5 py-px font-[family-name:var(--font-screen)] text-[11px] text-[#557a6e]">
            {shortcut}
          </kbd>
        )
      )}
    </div>
  );
}

/** Sections and their recipes as iron plates; the open one is lit brass. */
export function RecipeNav({
  sections,
  activeId,
  query,
  onOpen,
}: {
  sections: Section[];
  activeId: string;
  query: string;
  onOpen: OpenTarget;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !current || list.offsetParent === null) return;
    const listBox = list.getBoundingClientRect();
    const box = current.getBoundingClientRect();
    if (box.top < listBox.top || box.bottom > listBox.bottom) {
      list.scrollTop += box.top - listBox.top - listBox.height / 3;
    }
  }, [activeId]);

  return (
    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-8 pt-2">
      <nav aria-label="Recipes" className="space-y-1">
        {sections.map((section) => {
          const Glyph = sectionGlyph(section.id);
          const sectionOpen = activeId === section.id;
          const lit = sectionOpen || section.recipes.some((recipe) => recipe.id === activeId);
          return (
            <div key={section.id}>
              <HashLink
                to={section.id}
                onOpen={onOpen}
                aria-current={sectionOpen ? 'page' : undefined}
                className={cx(
                  'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-l-brass/70',
                  lit
                    ? litPlate
                    : 'border-transparent text-l-muted hover:bg-white/[0.03] hover:text-l-text'
                )}
              >
                <Glyph
                  className={cx('size-4 shrink-0', lit ? 'text-l-brass' : 'text-l-brass/55')}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-screen)] text-[14px] tracking-[0.04em]">
                  {section.title}
                </span>
                <span className="shrink-0 font-[family-name:var(--font-screen)] text-[11.5px] tabular-nums text-l-faint [text-shadow:none]">
                  {section.recipes.length}
                </span>
              </HashLink>
              <ul className="mb-2 ml-[1.32rem] mt-1 border-l border-l-brass/15">
                {section.recipes.map((recipe) => {
                  const selected = activeId === recipe.id;
                  return (
                    <li key={recipe.id}>
                      <HashLink
                        to={recipe.id}
                        onOpen={onOpen}
                        aria-current={selected ? 'page' : undefined}
                        className={cx(
                          'group relative flex items-baseline gap-2 rounded-r-md py-1.5 pl-3.5 pr-2 text-[13px] leading-snug transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-l-brass/70',
                          selected
                            ? 'bg-[linear-gradient(90deg,rgb(201_164_92/0.1),transparent)] text-[#a8d9c7]'
                            : 'text-l-faint hover:text-l-text'
                        )}
                      >
                        <span
                          aria-hidden
                          className={cx(
                            'absolute inset-y-1 -left-px w-px transition-colors',
                            selected ? 'bg-l-brass' : 'bg-transparent group-hover:bg-l-brass/40'
                          )}
                        />
                        <span className="min-w-0 flex-1">{recipe.title}</span>
                        <span className="shrink-0 font-mono text-[10.5px] text-l-faint/80">
                          {recipe.time}
                        </span>
                      </HashLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
        {sections.length === 0 && (
          <p className="px-3 py-2 text-sm text-l-muted">
            No recipes match <span className="text-l-text">“{query}”</span>.
          </p>
        )}
      </nav>
    </div>
  );
}
