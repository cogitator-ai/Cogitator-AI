export interface CapabilitiesInput {
  tools: Array<{ name: string; description: string }>;
  channels: string[];
  memoryStats?: { entities: number; relations: number };
  scheduledTasks?: number;
}

export function generateCapabilitiesDoc(input: CapabilitiesInput): string {
  const lines: string[] = ['# Assistant Capabilities', ''];

  lines.push('## Available Tools', '');
  for (const t of input.tools) {
    lines.push(`- **${t.name}** — ${t.description}`);
  }
  lines.push('');

  if (input.channels.length > 0) {
    lines.push('## Connected Channels', '');
    for (const ch of input.channels) {
      lines.push(`- ${ch}`);
    }
    lines.push('');
  }

  if (input.memoryStats) {
    lines.push('## Memory', '');
    lines.push(`- ${input.memoryStats.entities} entities in knowledge graph`);
    lines.push(`- ${input.memoryStats.relations} relations`);
    lines.push('');
  }

  if (input.scheduledTasks !== undefined) {
    lines.push('## Scheduled Tasks', '');
    lines.push(`- ${input.scheduledTasks} active scheduled tasks`);
    lines.push('');
  }

  return lines.join('\n');
}
