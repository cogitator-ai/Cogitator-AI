'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSelectedLayoutSegments } from 'next/navigation';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import { GithubIcon } from '@/components/icons/GithubIcon';
import { LogoMark, Wordmark } from '@/components/landing/Logo';
import { COMMUNITY, COOKBOOK_URL, DOCS_HOME, GITHUB_EXAMPLES_URL, GITHUB_URL } from '@/lib/site';
import { recipeCount, sections, type Recipe } from '../recipes';
import { legacyHashPath } from '../routes';
import { RecipeNav, SearchSlot, type ActiveRoute } from './RecipeNav';

const DRAWER_ID = 'cookbook-drawer';
const DESKTOP_QUERY = '(min-width: 768px)';

function matches(recipe: Recipe, query: string): boolean {
  return [recipe.title, recipe.problem, recipe.id].some((text) =>
    text.toLowerCase().includes(query)
  );
}

function readHash(): string {
  const raw = window.location.hash.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Chrome around every cookbook route: the header, the recipe list on an iron rail (a drawer on
 * phones) with search on Cmd/Ctrl+K, and the footer. The active section and recipe come from the
 * route; links from the old hash-routed cookbook (`/cookbook#approvals`) are sent to their pages.
 */
export function CookbookShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sectionId, recipeId] = useSelectedLayoutSegments();
  const active: ActiveRoute = { sectionId, recipeId };
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [focusDrawerSearch, setFocusDrawerSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [shortcut, setShortcut] = useState('⌘K');
  const [renderedPath, setRenderedPath] = useState(pathname);
  const [navigated, setNavigated] = useState(false);
  const desktopSearchRef = useRef<HTMLInputElement>(null);
  const historyNavigation = useRef(false);

  if (renderedPath !== pathname) {
    setRenderedPath(pathname);
    setNavigated(true);
    setDrawerOpen(false);
    setFocusDrawerSearch(false);
  }

  useEffect(() => {
    if (pathname !== COOKBOOK_URL) return;
    const redirect = () => {
      const target = legacyHashPath(readHash());
      if (target) router.replace(target);
    };
    redirect();
    window.addEventListener('hashchange', redirect);
    return () => window.removeEventListener('hashchange', redirect);
  }, [pathname, router]);

  useEffect(() => {
    const onPopState = () => {
      historyNavigation.current = true;
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!/Mac|iPhone|iPad/.test(navigator.userAgent)) setShortcut('Ctrl K');
  }, []);

  const scrolledPath = useRef(pathname);

  useLayoutEffect(() => {
    if (scrolledPath.current === pathname) return;
    scrolledPath.current = pathname;
    if (historyNavigation.current) {
      historyNavigation.current = false;
      return;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [pathname]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setFocusDrawerSearch(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        const input = desktopSearchRef.current;
        if (input && input.offsetParent !== null) {
          input.focus();
          input.select();
        } else {
          setDrawerOpen(true);
          setFocusDrawerSearch(true);
        }
      } else if (event.key === 'Escape' && drawerOpen) {
        closeDrawer();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen, closeDrawer]);

  useEffect(() => {
    if (!drawerOpen) return;
    const desktop = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => {
      if (desktop.matches) closeDrawer();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    desktop.addEventListener('change', onChange);
    return () => {
      document.body.style.overflow = previousOverflow;
      desktop.removeEventListener('change', onChange);
    };
  }, [drawerOpen, closeDrawer]);

  const filteredSections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sections;
    return sections
      .map((section) => ({
        ...section,
        recipes: section.title.toLowerCase().includes(needle)
          ? section.recipes
          : section.recipes.filter((recipe) => matches(recipe, needle)),
      }))
      .filter((section) => section.recipes.length > 0);
  }, [query]);

  return (
    <MotionConfig reducedMotion="user">
      <div className="dark landing-noise relative min-h-screen overflow-x-clip bg-l-bg text-l-text [color-scheme:dark]">
        <header className="iron-panel brass-edge fixed inset-x-0 top-0 z-50 border-b">
          <div className="flex h-16 items-center justify-between gap-3 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <Link
                href="/"
                aria-label="Cogitator home"
                className="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-l-brass/70"
              >
                <LogoMark className="sm:hidden" />
                <span className="hidden sm:block">
                  <Wordmark />
                </span>
              </Link>
              <span aria-hidden className="text-l-brass/35">
                /
              </span>
              <Link
                href={COOKBOOK_URL}
                aria-current={pathname === COOKBOOK_URL ? 'page' : undefined}
                className="vox-label truncate rounded-sm !text-[12.5px] transition-colors hover:!text-[#e2c58c] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-l-brass/70"
              >
                Cookbook
              </Link>
              <span className="readout hidden px-2 py-0.5 text-[11.5px] uppercase tracking-[0.1em] lg:inline">
                {recipeCount} recipes
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              <Link
                href={DOCS_HOME}
                className="vox-label rounded-md px-2 py-1.5 !text-[12px] !text-l-muted transition-colors hover:!text-[#e2c58c] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-l-brass/70 sm:px-3"
              >
                Docs
              </Link>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Cogitator on GitHub"
                className="rounded-md p-2 text-l-muted transition-colors hover:text-l-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-l-brass/70"
              >
                <GithubIcon className="size-[18px]" />
              </a>
              <button
                type="button"
                onClick={() => (drawerOpen ? closeDrawer() : setDrawerOpen(true))}
                aria-label={drawerOpen ? 'Close recipe list' : 'Open recipe list'}
                aria-expanded={drawerOpen}
                aria-controls={DRAWER_ID}
                className="grid size-9 place-items-center rounded-md border border-l-brass/30 text-l-brass transition-colors hover:border-l-brass/60 hover:text-[#e2c58c] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-l-brass/70 md:hidden"
              >
                {drawerOpen ? (
                  <X className="size-[18px]" aria-hidden />
                ) : (
                  <Menu className="size-[18px]" aria-hidden />
                )}
              </button>
            </div>
          </div>
        </header>

        <AnimatePresence>
          {drawerOpen && (
            <motion.div
              key="drawer"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed inset-x-0 bottom-0 top-16 z-40 md:hidden"
            >
              <button
                type="button"
                tabIndex={-1}
                aria-label="Close recipe list"
                onClick={closeDrawer}
                className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
              />
              <motion.div
                id={DRAWER_ID}
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ type: 'tween', duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                className="iron-panel brass-edge absolute inset-y-0 left-0 flex w-[min(20rem,86vw)] flex-col border-r"
              >
                <div className="px-4 pb-3 pt-4">
                  <SearchSlot value={query} onChange={setQuery} autoFocus={focusDrawerSearch} />
                </div>
                <RecipeNav sections={filteredSections} active={active} query={query} />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <aside className="iron-panel brass-edge fixed bottom-0 left-0 top-16 z-30 hidden w-72 flex-col border-r md:flex">
          <div className="px-4 pb-3 pt-4">
            <SearchSlot
              value={query}
              onChange={setQuery}
              inputRef={desktopSearchRef}
              shortcut={shortcut}
            />
          </div>
          <RecipeNav sections={filteredSections} active={active} query={query} />
        </aside>

        <main className="relative min-h-screen pt-16 md:pl-72">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(50%_60%_at_60%_0%,rgba(255,179,71,0.07),transparent_70%)]"
          />
          <div className="relative mx-auto max-w-4xl px-4 pb-16 pt-10 sm:px-8 sm:pt-14">
            <motion.div
              key={pathname}
              initial={navigated ? { opacity: 0, y: 8 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              {children}
            </motion.div>

            <div className="brass-rule mt-20" aria-hidden />
            <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
              <a
                href={GITHUB_EXAMPLES_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="brass-ghost group text-[12px]"
              >
                All examples on GitHub
                <ArrowUpRight
                  className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                  aria-hidden
                />
              </a>
              <a
                href={COMMUNITY.url}
                target="_blank"
                rel="noopener noreferrer"
                className="vox-label !text-[12px] !text-l-muted transition-colors hover:!text-[#e2c58c]"
              >
                {COMMUNITY.name}
              </a>
            </div>
          </div>
        </main>
      </div>
    </MotionConfig>
  );
}
