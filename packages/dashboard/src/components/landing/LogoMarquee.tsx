import {
  siAnthropic,
  siBun,
  siCloudflareworkers,
  siDeepseek,
  siDeno,
  siDiscord,
  siDocker,
  siExpress,
  siFastify,
  siFlydotio,
  siGooglegemini,
  siHono,
  siKoa,
  siMistralai,
  siModelcontextprotocol,
  siMongodb,
  siNextdotjs,
  siNodedotjs,
  siOllama,
  siOpentelemetry,
  siPostgresql,
  siQdrant,
  siRedis,
  siSqlite,
  siTelegram,
  siTypescript,
  siVllm,
  siWhatsapp,
  type SimpleIcon,
} from 'simple-icons';
import type { CSSProperties } from 'react';
import { BUILTIN_TOOL_COUNT, EXAMPLE_COUNT, LLM_PROVIDERS, NPM_PACKAGE_COUNT } from '@/lib/stats';

interface Brand {
  name: string;
  icon?: SimpleIcon;
}

const MODELS: Brand[] = [
  { name: 'Anthropic', icon: siAnthropic },
  { name: 'OpenAI' },
  { name: 'Gemini', icon: siGooglegemini },
  { name: 'Ollama', icon: siOllama },
  { name: 'Mistral', icon: siMistralai },
  { name: 'DeepSeek', icon: siDeepseek },
  { name: 'vLLM', icon: siVllm },
  { name: 'Groq' },
  { name: 'Together' },
  { name: 'AWS Bedrock' },
  { name: 'Azure OpenAI' },
];

const PLATFORM: Brand[] = [
  { name: 'TypeScript', icon: siTypescript },
  { name: 'Node.js', icon: siNodedotjs },
  { name: 'Bun', icon: siBun },
  { name: 'Deno', icon: siDeno },
  { name: 'Cloudflare Workers', icon: siCloudflareworkers },
  { name: 'Next.js', icon: siNextdotjs },
  { name: 'Express', icon: siExpress },
  { name: 'Fastify', icon: siFastify },
  { name: 'Hono', icon: siHono },
  { name: 'Koa', icon: siKoa },
  { name: 'Redis', icon: siRedis },
  { name: 'PostgreSQL', icon: siPostgresql },
  { name: 'SQLite', icon: siSqlite },
  { name: 'MongoDB', icon: siMongodb },
  { name: 'Qdrant', icon: siQdrant },
  { name: 'Docker', icon: siDocker },
  { name: 'MCP', icon: siModelcontextprotocol },
  { name: 'OpenTelemetry', icon: siOpentelemetry },
  { name: 'Telegram', icon: siTelegram },
  { name: 'Discord', icon: siDiscord },
  { name: 'WhatsApp', icon: siWhatsapp },
  { name: 'Fly.io', icon: siFlydotio },
];

function BrandItem({ brand }: { brand: Brand }) {
  return (
    <li className="flex shrink-0 items-center gap-2.5 px-7 text-l-muted transition-colors duration-300 hover:text-l-text">
      {brand.icon && (
        <svg viewBox="0 0 24 24" className="size-[18px] fill-current" aria-hidden>
          <path d={brand.icon.path} />
        </svg>
      )}
      <span className="whitespace-nowrap text-[15px] font-medium tracking-[-0.01em]">
        {brand.name}
      </span>
    </li>
  );
}

/** A row that moves left to right forever; the list is rendered twice so the loop is seamless. */
function MarqueeRow({
  brands,
  seconds,
  label,
}: {
  brands: Brand[];
  seconds: number;
  label: string;
}) {
  return (
    <div
      className="marquee relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]"
      aria-label={label}
    >
      <ul
        className="marquee-track flex w-max py-3"
        style={{ '--marquee-duration': `${seconds}s` } as CSSProperties}
      >
        {[...brands, ...brands].map((brand, index) => (
          <BrandItem key={`${brand.name}-${index}`} brand={brand} />
        ))}
      </ul>
    </div>
  );
}

const STATS = [
  { value: LLM_PROVIDERS.length, label: 'LLM providers' },
  { value: NPM_PACKAGE_COUNT, label: 'npm packages' },
  { value: BUILTIN_TOOL_COUNT, label: 'built-in tools' },
  { value: EXAMPLE_COUNT, label: 'runnable examples' },
];

export function LogoMarquee() {
  return (
    <section className="iron-panel brass-edge relative border-y py-10">
      <p className="vox-label mb-6 text-center">
        +++ Any model · any runtime · your infrastructure +++
      </p>
      <div className="space-y-2">
        <MarqueeRow brands={MODELS} seconds={48} label="Supported model providers" />
        <MarqueeRow brands={PLATFORM} seconds={70} label="Runtimes, frameworks and integrations" />
      </div>
      <dl className="mx-auto mt-10 grid max-w-4xl grid-cols-2 gap-4 px-5 sm:grid-cols-4">
        {STATS.map((stat) => (
          <div key={stat.label} className="readout flex flex-col px-3 py-3 text-center">
            <dt className="order-2 mt-1 text-[12px] uppercase tracking-[0.14em] text-[#7fa89a]">
              {stat.label}
            </dt>
            <dd className="text-3xl tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
