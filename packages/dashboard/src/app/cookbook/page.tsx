'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { COMMUNITY, GITHUB_EXAMPLES_URL, GITHUB_URL } from '@/lib/site';
import {
  findRecipe,
  recipeCount,
  sections,
  type CodeSample,
  type Difficulty,
  type Recipe,
  type RecipeNote,
  type Section,
} from './recipes';

const OVERVIEW_ID = 'overview';
const EXAMPLES_BLOB_URL = `${GITHUB_URL}/blob/main/examples`;
const allRecipes = sections.flatMap((section) => section.recipes);

function InlineText({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <code
            key={index}
            className="px-1 py-0.5 rounded bg-[#1a1a1a] text-[#e1e1e1] text-[0.9em] font-mono"
          >
            {part}
          </code>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </>
  );
}

function CodeBlock({ children, label = 'typescript' }: { children: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="relative group my-4">
      <div className="absolute top-2 right-2 z-10">
        <button
          onClick={copy}
          className="px-2 py-1 text-xs bg-[#1a1a1a] text-[#666] rounded border border-[#333] hover:border-[#00ff88] hover:text-[#00ff88] transition-all"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <div className="absolute top-2 left-3 text-xs text-[#666] font-mono">{label}</div>
      <pre className="bg-[#0f0f0f] border border-[#1a1a1a] rounded-lg p-4 pt-8 overflow-x-auto">
        <code className="text-sm font-mono text-[#e1e1e1]">{children}</code>
      </pre>
    </div>
  );
}

function Callout({ note }: { note: RecipeNote }) {
  const styles = {
    info: 'border-[#00aaff] bg-[#00aaff]/5',
    warning: 'border-[#ffaa00] bg-[#ffaa00]/5',
    tip: 'border-[#00ff88] bg-[#00ff88]/5',
  };
  const icons = { info: 'ℹ️', warning: '⚠️', tip: '💡' };

  return (
    <div className={`my-4 p-4 border-l-4 rounded-r-lg ${styles[note.type]}`}>
      <span className="mr-2">{icons[note.type]}</span>
      <span className="text-[#e1e1e1]">
        <InlineText text={note.text} />
      </span>
    </div>
  );
}

function DifficultyBadge({ level }: { level: Difficulty }) {
  const colors = {
    easy: 'bg-[#00ff88]/10 text-[#00ff88] border-[#00ff88]/30',
    medium: 'bg-[#ffaa00]/10 text-[#ffaa00] border-[#ffaa00]/30',
    advanced: 'bg-[#ff5555]/10 text-[#ff5555] border-[#ff5555]/30',
  };
  return <span className={`px-2 py-0.5 text-xs rounded border ${colors[level]}`}>{level}</span>;
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">{children}</h3>;
}

function RecipeCard({ recipe, onOpen }: { recipe: Recipe; onOpen: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpen(recipe.id)}
      className="text-left p-4 bg-[#111] border border-[#222] rounded-lg hover:border-[#00ff88]/50 transition-colors"
    >
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-[#fafafa] font-semibold flex-1">{recipe.title}</h3>
        <DifficultyBadge level={recipe.difficulty} />
      </div>
      <p className="text-[#888] text-sm">{recipe.problem}</p>
    </button>
  );
}

function Overview({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <>
      <h1 className="text-4xl font-bold text-[#fafafa] mb-4">Cookbook</h1>
      <p className="text-[#a1a1a1] text-lg mb-8">
        {recipeCount} recipes, each a complete program you can copy and run. Every recipe is
        type-checked against the current packages and comes from — or links to — a runnable example
        in the repository.
      </p>

      <h3 className="text-xl font-bold text-[#fafafa] mt-6 mb-3">Run a recipe on its own</h3>
      <p className="text-[#a1a1a1] mb-2">
        Recipes use top-level <code className="text-[#e1e1e1]">await</code>, so run them in an ES
        module project. Each recipe lists the packages to add and the command to run it.
      </p>
      <CodeBlock label="bash">{`mkdir cogitator-recipes && cd cogitator-recipes
npm init -y && npm pkg set type=module
pnpm add -D tsx typescript @types/node`}</CodeBlock>
      <p className="text-[#a1a1a1] mb-2">
        Most recipes call Google Gemini, which has a free tier — get a key at{' '}
        <a
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#00ff88] hover:underline"
        >
          Google AI Studio
        </a>
        . Swap the provider and model to use OpenAI, Anthropic or a local Ollama model instead.
      </p>

      <h3 className="text-xl font-bold text-[#fafafa] mt-8 mb-3">Or run the full examples</h3>
      <CodeBlock label="bash">{`git clone ${GITHUB_URL}.git && cd Cogitator-AI
pnpm install && pnpm build
echo "GOOGLE_API_KEY=your-key" > .env
npx tsx examples/core/01-basic-agent.ts`}</CodeBlock>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-10">
        {sections.map((section) => (
          <button
            key={section.id}
            onClick={() => onOpen(section.id)}
            className="text-left p-4 bg-[#111] border border-[#222] rounded-lg hover:border-[#00ff88]/50 transition-colors"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-2xl">{section.icon}</span>
              <h3 className="text-[#fafafa] font-semibold flex-1">{section.title}</h3>
              <span className="text-[#444] text-xs">{section.recipes.length}</span>
            </div>
            <p className="text-[#666] text-sm">{section.description}</p>
          </button>
        ))}
      </div>
    </>
  );
}

function SectionView({ section, onOpen }: { section: Section; onOpen: (id: string) => void }) {
  return (
    <>
      <h1 className="text-4xl font-bold text-[#fafafa] mb-4">
        <span className="mr-3">{section.icon}</span>
        {section.title}
      </h1>
      <p className="text-[#a1a1a1] text-lg mb-8">{section.description}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {section.recipes.map((recipe) => (
          <RecipeCard key={recipe.id} recipe={recipe} onOpen={onOpen} />
        ))}
      </div>
    </>
  );
}

function ExtraBlock({ sample }: { sample: CodeSample }) {
  return (
    <>
      <Heading>{sample.title}</Heading>
      <CodeBlock label={sample.language}>{sample.code}</CodeBlock>
    </>
  );
}

function RecipeView({
  recipe,
  section,
  onOpen,
}: {
  recipe: Recipe;
  section: Section;
  onOpen: (id: string) => void;
}) {
  const index = allRecipes.findIndex((candidate) => candidate.id === recipe.id);
  const previous = allRecipes[index - 1];
  const next = allRecipes[index + 1];

  return (
    <>
      <button
        onClick={() => onOpen(section.id)}
        className="text-[#666] hover:text-[#00ff88] text-sm mb-3 transition-colors"
      >
        {section.icon} {section.title}
      </button>
      <h2 className="text-3xl font-bold text-[#fafafa] mb-2">{recipe.title}</h2>
      <div className="flex items-center gap-3 mb-6">
        <DifficultyBadge level={recipe.difficulty} />
        <span className="text-[#666] text-sm">{recipe.time}</span>
      </div>

      <p className="text-[#a1a1a1] text-lg">
        <InlineText text={recipe.problem} />
      </p>

      <Heading>What it shows</Heading>
      <ul className="list-disc list-inside text-[#a1a1a1] space-y-1">
        {recipe.points.map((point) => (
          <li key={point}>
            <InlineText text={point} />
          </li>
        ))}
      </ul>

      <Heading>The code</Heading>
      <CodeBlock label={recipe.file}>{recipe.code}</CodeBlock>

      {recipe.notes?.map((note) => (
        <Callout key={note.text} note={note} />
      ))}

      <Heading>Run it</Heading>
      <CodeBlock label="bash">
        {recipe.setup ? `${recipe.install}\n${recipe.setup}` : recipe.install}
      </CodeBlock>
      {recipe.env.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-[#a1a1a1]">
          <span>Environment:</span>
          {recipe.env.map((name) => (
            <code
              key={name}
              className="px-2 py-0.5 rounded bg-[#111] border border-[#222] text-[#e1e1e1] font-mono text-xs"
            >
              {name}
            </code>
          ))}
        </div>
      )}
      <CodeBlock label="bash">{recipe.run}</CodeBlock>
      {recipe.repoRun && (
        <>
          <p className="text-[#a1a1a1]">
            Or run the full example from a clone of the repository (keys in{' '}
            <code className="text-[#e1e1e1]">.env</code>):
          </p>
          <CodeBlock label="bash">{recipe.repoRun}</CodeBlock>
        </>
      )}
      {recipe.runNote && (
        <p className="text-[#a1a1a1]">
          <InlineText text={recipe.runNote} />
        </p>
      )}

      {recipe.extra?.map((sample) => (
        <ExtraBlock key={sample.title} sample={sample} />
      ))}

      <Heading>Learn more</Heading>
      <ul className="space-y-2">
        {recipe.example && (
          <li>
            <a
              href={`${EXAMPLES_BLOB_URL}/${recipe.example}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#00ff88] hover:underline font-mono text-sm"
            >
              examples/{recipe.example} →
            </a>
          </li>
        )}
        {recipe.docs.map((doc) => (
          <li key={doc.href}>
            <Link href={doc.href} className="text-[#00ff88] hover:underline text-sm">
              Docs: {doc.label} →
            </Link>
          </li>
        ))}
      </ul>

      <div className="mt-12 flex items-center justify-between gap-4 text-sm">
        {previous ? (
          <button
            onClick={() => onOpen(previous.id)}
            className="text-[#666] hover:text-[#00ff88] transition-colors text-left"
          >
            ← {previous.title}
          </button>
        ) : (
          <span />
        )}
        {next && (
          <button
            onClick={() => onOpen(next.id)}
            className="text-[#666] hover:text-[#00ff88] transition-colors text-right"
          >
            {next.title} →
          </button>
        )}
      </div>
    </>
  );
}

function Content({ activeId, onOpen }: { activeId: string; onOpen: (id: string) => void }) {
  const section = sections.find((candidate) => candidate.id === activeId);
  if (section) return <SectionView section={section} onOpen={onOpen} />;

  const found = findRecipe(activeId);
  if (found) return <RecipeView recipe={found.recipe} section={found.section} onOpen={onOpen} />;

  return <Overview onOpen={onOpen} />;
}

function matches(recipe: Recipe, query: string): boolean {
  if (!query) return true;
  return [recipe.title, recipe.problem, recipe.id].some((text) =>
    text.toLowerCase().includes(query)
  );
}

export default function CookbookPage() {
  const [activeId, setActiveId] = useState(OVERVIEW_ID);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const syncFromHash = () => setActiveId(window.location.hash.slice(1) || OVERVIEW_ID);
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const open = useCallback((id: string) => {
    setActiveId(id);
    setMobileMenuOpen(false);
    window.history.pushState(null, '', `#${id}`);
    window.scrollTo({ top: 0 });
  }, []);

  const filteredSections = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return sections
      .map((section) => ({
        ...section,
        recipes: section.title.toLowerCase().includes(query)
          ? section.recipes
          : section.recipes.filter((recipe) => matches(recipe, query)),
      }))
      .filter((section) => section.recipes.length > 0);
  }, [searchQuery]);

  const isActiveSection = (section: Section) =>
    activeId === section.id || section.recipes.some((recipe) => recipe.id === activeId);

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <header className="fixed top-0 left-0 right-0 z-50 bg-[#0a0a0a]/80 backdrop-blur-xl border-b border-[#1a1a1a]">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-8 h-8 bg-gradient-to-br from-[#00ff88] to-[#00aa55] rounded-lg flex items-center justify-center">
                <span className="text-[#0a0a0a] font-bold text-lg">C</span>
              </div>
              <span className="text-[#fafafa] font-bold text-xl hidden sm:block">Cogitator</span>
            </Link>
            <span className="text-[#333] hidden sm:block">/</span>
            <button
              onClick={() => open(OVERVIEW_ID)}
              className="text-[#00ff88] font-mono text-sm hidden sm:block"
            >
              cookbook
            </button>
            <span className="text-[#444] text-xs hidden md:block">({recipeCount} recipes)</span>
          </div>

          <div className="flex items-center gap-4">
            <div className="relative hidden md:block">
              <input
                ref={searchRef}
                type="text"
                placeholder="Search recipes..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-64 px-4 py-2 bg-[#111] border border-[#222] rounded-lg text-[#fafafa] text-sm placeholder-[#666] focus:outline-none focus:border-[#00ff88]"
              />
              <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[#444] text-xs">
                ⌘K
              </kbd>
            </div>
            <Link
              href="/docs"
              className="px-3 py-2 text-[#a1a1a1] hover:text-[#fafafa] text-sm transition-colors"
            >
              Docs
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-[#00ff88] text-[#0a0a0a] font-semibold rounded-lg text-sm hover:bg-[#00cc6a] transition-colors"
            >
              GitHub
            </a>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-2 text-[#fafafa]"
              aria-label="Open recipe list"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, x: -300 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -300 }}
            className="fixed inset-0 z-40 md:hidden"
          >
            <div
              className="absolute inset-0 bg-black/50"
              onClick={() => setMobileMenuOpen(false)}
            />
            <div className="absolute left-0 top-0 bottom-0 w-72 bg-[#0a0a0a] border-r border-[#1a1a1a] pt-20 p-4 overflow-auto">
              {sections.map((section) => (
                <div key={section.id} className="mb-4">
                  <button
                    onClick={() => open(section.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 ${
                      activeId === section.id
                        ? 'bg-[#00ff88]/10 text-[#00ff88]'
                        : 'text-[#a1a1a1] hover:text-[#fafafa]'
                    }`}
                  >
                    <span>{section.icon}</span>
                    <span>{section.title}</span>
                  </button>
                  {section.recipes.map((recipe) => (
                    <button
                      key={recipe.id}
                      onClick={() => open(recipe.id)}
                      className={`w-full text-left pl-10 pr-3 py-1 text-sm ${
                        activeId === recipe.id
                          ? 'text-[#00ff88]'
                          : 'text-[#666] hover:text-[#a1a1a1]'
                      }`}
                    >
                      {recipe.title}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex pt-16">
        <aside className="hidden md:block w-72 fixed left-0 top-16 bottom-0 border-r border-[#1a1a1a] overflow-auto p-4">
          <nav className="space-y-1">
            {filteredSections.map((section) => (
              <div key={section.id}>
                <button
                  onClick={() => open(section.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 transition-colors ${
                    isActiveSection(section)
                      ? 'bg-[#00ff88]/10 text-[#00ff88]'
                      : 'text-[#a1a1a1] hover:text-[#fafafa] hover:bg-[#111]'
                  }`}
                >
                  <span>{section.icon}</span>
                  <span className="font-medium">{section.title}</span>
                  <span className="ml-auto text-xs text-[#444]">{section.recipes.length}</span>
                </button>
                <div className="ml-4 mt-1 space-y-0.5">
                  {section.recipes.map((recipe) => (
                    <button
                      key={recipe.id}
                      onClick={() => open(recipe.id)}
                      className={`w-full text-left pl-6 pr-3 py-1.5 rounded text-sm transition-colors flex items-center gap-2 ${
                        activeId === recipe.id
                          ? 'text-[#00ff88] bg-[#00ff88]/5'
                          : 'text-[#666] hover:text-[#a1a1a1]'
                      }`}
                    >
                      <span className="flex-1">{recipe.title}</span>
                      <span className="text-[#444] text-xs">{recipe.time}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {filteredSections.length === 0 && (
              <p className="px-3 py-2 text-sm text-[#666]">No recipes match “{searchQuery}”.</p>
            )}
          </nav>
        </aside>

        <main className="flex-1 md:ml-72 min-h-screen min-w-0">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
            <motion.div
              key={activeId}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div className="prose prose-invert max-w-none">
                <Content activeId={activeId} onOpen={open} />
              </div>
            </motion.div>

            <div className="mt-16 pt-8 border-t border-[#1a1a1a] flex items-center justify-between text-sm">
              <a
                href={GITHUB_EXAMPLES_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#00ff88] hover:underline"
              >
                View all examples on GitHub →
              </a>
              <a
                href={COMMUNITY.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#a1a1a1] hover:text-[#fafafa] transition-colors"
              >
                {COMMUNITY.name}
              </a>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
