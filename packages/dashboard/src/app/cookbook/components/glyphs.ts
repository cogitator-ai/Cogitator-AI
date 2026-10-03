import {
  BookOpen,
  Bot,
  Brain,
  Cloud,
  Container,
  Cpu,
  Database,
  Gauge,
  Globe,
  MessagesSquare,
  Mic,
  Network,
  Plug,
  Rocket,
  Server,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

const glyphs: Record<string, LucideIcon> = {
  'getting-started': Rocket,
  agents: Bot,
  memory: Database,
  workflows: Workflow,
  swarms: Network,
  reasoning: Brain,
  safety: ShieldCheck,
  protocols: Plug,
  servers: Server,
  edge: Cloud,
  evals: Gauge,
  voice: Mic,
  browser: Globe,
  channels: MessagesSquare,
  infrastructure: Container,
  advanced: Cpu,
};

/** Line icon for a cookbook section, drawn in the landing's brass instead of the section's emoji. */
export function sectionGlyph(sectionId: string): LucideIcon {
  return glyphs[sectionId] ?? BookOpen;
}
