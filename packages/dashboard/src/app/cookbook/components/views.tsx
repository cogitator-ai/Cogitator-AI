import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Clock, FileCode } from 'lucide-react';
import { GithubIcon } from '@/components/icons/GithubIcon';
import { Badge, Eyebrow, cx } from '@/components/landing/ui';
import { COOKBOOK_URL, GITHUB_URL } from '@/lib/site';
import { recipeCount, sections, type Recipe, type Section } from '../recipes';
import { recipeNeighbours, recipePath, sectionPath } from '../routes';
import { CodeWindow } from './CodeWindow';
import { sectionGlyph } from './glyphs';
import {
  Callout,
  DifficultyGauge,
  InlineText,
  MinorHeading,
  PointList,
  SubHeading,
} from './primitives';

const EXAMPLES_BLOB_URL = `${GITHUB_URL}/blob/main/examples`;

const STANDALONE_SETUP = `mkdir cogitator-recipes && cd cogitator-recipes
npm init -y && npm pkg set type=module
pnpm add -D tsx typescript @types/node`;

const REPO_SETUP = `git clone ${GITHUB_URL}.git && cd Cogitator-AI
pnpm install && pnpm build
echo "GOOGLE_API_KEY=your-key" > .env
npx tsx examples/core/01-basic-agent.ts`;

const cardClass =
  'group iron-panel relative flex flex-col rounded-xl border border-l-brass/20 p-4 text-left transition-[border-color,box-shadow] duration-200 hover:border-l-brass/55 hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.07),0_0_24px_-10px_rgb(201_164_92/0.45)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-l-brass/70 sm:p-5';

const proseLink =
  'text-[#e2c58c] underline decoration-l-brass/40 underline-offset-[3px] transition-colors hover:text-[#f0d9a6] hover:decoration-l-brass';

function PageTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className="imperial mt-4 text-[2rem] font-semibold leading-[1.1] text-l-text text-balance sm:text-[2.7rem]">
      {children}
    </h1>
  );
}

function Lead({ children }: { children: ReactNode }) {
  return (
    <p className="mt-5 text-base leading-relaxed text-l-muted text-pretty sm:text-[17px]">
      {children}
    </p>
  );
}

function Paragraph({ children }: { children: ReactNode }) {
  return <p className="text-[15px] leading-relaxed text-l-muted">{children}</p>;
}

function Breadcrumbs({ trail }: { trail?: Section }) {
  const crumb =
    'rounded-sm transition-colors hover:text-[#e2c58c] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-l-brass/70';
  return (
    <nav
      aria-label="Breadcrumb"
      className="vox-label flex flex-wrap items-center gap-x-2 !text-[12px]"
    >
      <Link href={COOKBOOK_URL} className={cx(crumb, 'text-l-brass/80')}>
        Cookbook
      </Link>
      {trail && (
        <>
          <span aria-hidden className="text-l-brass/40">
            /
          </span>
          <Link href={sectionPath(trail)} className={cx(crumb, 'text-l-brass/80')}>
            {trail.title}
          </Link>
        </>
      )}
    </nav>
  );
}

function SectionCard({ section }: { section: Section }) {
  const Glyph = sectionGlyph(section.id);
  return (
    <Link href={sectionPath(section)} className={cardClass}>
      <span className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-l-brass/30 bg-[linear-gradient(180deg,#1d1912,#0c0b09)] text-l-brass shadow-[inset_0_1px_0_rgb(226_197_140/0.15)]">
          <Glyph width={18} height={18} className="block size-[18px] shrink-0" aria-hidden />
        </span>
        <span className="imperial min-w-0 flex-1 text-[15.5px] font-semibold leading-tight text-l-text">
          {section.title}
        </span>
        <span className="readout shrink-0 px-2 py-0.5 text-[12px] tabular-nums">
          {section.recipes.length}
        </span>
      </span>
      <span className="mt-3 text-sm leading-relaxed text-l-muted">{section.description}</span>
    </Link>
  );
}

function RecipeCard({ section, recipe }: { section: Section; recipe: Recipe }) {
  return (
    <Link href={recipePath(section, recipe)} className={cardClass}>
      <span className="imperial text-[15.5px] font-semibold leading-snug text-l-text">
        {recipe.title}
      </span>
      <span className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <DifficultyGauge level={recipe.difficulty} />
        <span className="inline-flex items-center gap-1.5 font-[family-name:var(--font-screen)] text-[11.5px] uppercase tracking-[0.12em] text-l-faint">
          <Clock className="size-3" aria-hidden />
          {recipe.time}
        </span>
      </span>
      <span className="mt-3 text-sm leading-relaxed text-l-muted">
        <InlineText text={recipe.problem} />
      </span>
      <ArrowRight
        aria-hidden
        className="absolute right-4 top-4 size-4 text-l-brass/0 transition-[color,transform] duration-200 group-hover:translate-x-0.5 group-hover:text-l-brass/80 sm:right-5 sm:top-5"
      />
    </Link>
  );
}

/** The cookbook's landing view: how to run recipes, then every section. */
export function CookbookOverview() {
  return (
    <>
      <Eyebrow>recipe archive</Eyebrow>
      <PageTitle>Cookbook</PageTitle>
      <Lead>
        {recipeCount} recipes, each a complete program you can copy and run. Every recipe is
        type-checked against the current packages and comes from — or links to — a runnable example
        in the repository.
      </Lead>
      <div className="mt-6 flex flex-wrap gap-3">
        <span className="readout px-3 py-1 text-[13px] uppercase tracking-[0.12em]">
          {recipeCount} recipes
        </span>
        <span className="readout px-3 py-1 text-[13px] uppercase tracking-[0.12em]">
          {sections.length} sections
        </span>
      </div>

      <SubHeading>Run a recipe on its own</SubHeading>
      <Paragraph>
        Recipes use top-level <InlineText text="`await`" />, so run them in an ES module project.
        Each recipe lists the packages to add and the command to run it.
      </Paragraph>
      <CodeWindow code={STANDALONE_SETUP} language="bash" title="new project · bash" />
      <Paragraph>
        Most recipes call Google Gemini, which has a free tier — get a key at{' '}
        <a
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noopener noreferrer"
          className={proseLink}
        >
          Google AI Studio
        </a>
        . Swap the provider and model to use OpenAI, Anthropic or a local Ollama model instead.
      </Paragraph>

      <SubHeading>Or run the full examples</SubHeading>
      <CodeWindow code={REPO_SETUP} language="bash" title="repository · bash" />

      <div className="brass-rule my-14" aria-hidden />

      <p className="vox-label !text-[12px]">+++ sections +++</p>
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {sections.map((section) => (
          <SectionCard key={section.id} section={section} />
        ))}
      </div>
    </>
  );
}

/** One section: its description and a card per recipe. */
export function SectionView({ section }: { section: Section }) {
  const Glyph = sectionGlyph(section.id);
  return (
    <>
      <Breadcrumbs />
      <PageTitle>
        <span className="flex items-center gap-3.5">
          <Glyph className="size-7 shrink-0 text-l-brass sm:size-8" aria-hidden />
          {section.title}
        </span>
      </PageTitle>
      <Lead>{section.description}</Lead>
      <p className="vox-label mt-10 !text-[12px]">
        +++ {section.recipes.length} {section.recipes.length === 1 ? 'recipe' : 'recipes'} +++
      </p>
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {section.recipes.map((recipe) => (
          <RecipeCard key={recipe.id} section={section} recipe={recipe} />
        ))}
      </div>
    </>
  );
}

function NeighbourLink({
  section,
  recipe,
  direction,
}: {
  section: Section;
  recipe: Recipe;
  direction: 'previous' | 'next';
}) {
  const isNext = direction === 'next';
  return (
    <Link
      href={recipePath(section, recipe)}
      className={cx(cardClass, '!p-4', isNext && 'sm:col-start-2 sm:items-end sm:text-right')}
    >
      <span className="vox-label inline-flex items-center gap-1.5 !text-[11.5px]">
        {!isNext && <ArrowLeft className="size-3.5" aria-hidden />}
        {isNext ? 'Next' : 'Previous'}
        {isNext && <ArrowRight className="size-3.5" aria-hidden />}
      </span>
      <span className="mt-1.5 text-[15px] font-medium text-l-text">{recipe.title}</span>
    </Link>
  );
}

/** A full recipe: what it shows, the code, how to run it and where to read more. */
export function RecipeView({ recipe, section }: { recipe: Recipe; section: Section }) {
  const { previous, next } = recipeNeighbours(recipe.id);
  const install = recipe.setup ? `${recipe.install}\n${recipe.setup}` : recipe.install;

  return (
    <article>
      <Breadcrumbs trail={section} />
      <PageTitle>{recipe.title}</PageTitle>
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2.5">
        <DifficultyGauge level={recipe.difficulty} />
        <Badge>
          <Clock className="size-3" aria-hidden />
          {recipe.time}
        </Badge>
        <Badge tone="brass">
          <FileCode className="size-3" aria-hidden />
          {recipe.file}
        </Badge>
      </div>
      <Lead>
        <InlineText text={recipe.problem} />
      </Lead>

      <SubHeading>What it shows</SubHeading>
      <PointList items={recipe.points} />

      <SubHeading>The code</SubHeading>
      <CodeWindow code={recipe.code} language="typescript" title={recipe.file} />

      {recipe.notes?.map((note) => (
        <Callout key={note.text} note={note} />
      ))}

      <SubHeading>Run it</SubHeading>
      <CodeWindow code={install} language="bash" title="install · bash" />
      {recipe.env.length > 0 && (
        <div className="my-5 flex flex-wrap items-center gap-2.5">
          <span className="vox-label !text-[12px]">Environment</span>
          {recipe.env.map((name) => (
            <code
              key={name}
              className="readout max-w-full px-2 py-0.5 text-[12.5px] [overflow-wrap:anywhere]"
            >
              {name}
            </code>
          ))}
        </div>
      )}
      <CodeWindow code={recipe.run} language="bash" title="run · bash" />
      {recipe.repoRun && (
        <>
          <Paragraph>
            Or run the full example from a clone of the repository (keys in{' '}
            <InlineText text="`.env`" />
            ):
          </Paragraph>
          <CodeWindow code={recipe.repoRun} language="bash" title="repository · bash" />
        </>
      )}
      {recipe.runNote && (
        <Paragraph>
          <InlineText text={recipe.runNote} />
        </Paragraph>
      )}

      {recipe.extra?.map((sample) => (
        <section key={sample.title}>
          <MinorHeading>{sample.title}</MinorHeading>
          <CodeWindow
            code={sample.code}
            language={sample.language}
            title={`${sample.title} · ${sample.language}`}
          />
        </section>
      ))}

      <SubHeading>Learn more</SubHeading>
      <ul className="space-y-2.5">
        {recipe.example && (
          <li>
            <a
              href={`${EXAMPLES_BLOB_URL}/${recipe.example}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-2.5 text-sm text-l-muted transition-colors hover:text-[#e2c58c]"
            >
              <GithubIcon className="size-4 shrink-0 text-l-brass/80" />
              <span className="font-mono [overflow-wrap:anywhere]">examples/{recipe.example}</span>
              <ArrowUpRight
                className="size-3.5 shrink-0 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                aria-hidden
              />
            </a>
          </li>
        )}
        {recipe.docs.map((doc) => (
          <li key={doc.href}>
            <Link
              href={doc.href}
              className="group inline-flex items-center gap-2.5 text-sm text-l-muted transition-colors hover:text-[#e2c58c]"
            >
              <BookOpen className="size-4 shrink-0 text-l-brass/80" aria-hidden />
              <span>Docs: {doc.label}</span>
              <ArrowRight
                className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>

      {(previous || next) && (
        <nav aria-label="More recipes" className="mt-14 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {previous && <NeighbourLink {...previous} direction="previous" />}
          {next && <NeighbourLink {...next} direction="next" />}
        </nav>
      )}
    </article>
  );
}
