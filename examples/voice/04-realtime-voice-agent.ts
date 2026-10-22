import { WebSocket } from 'ws';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { header, section } from '../_shared/setup.js';
import { createCogitatorRunner, VoiceAgent } from '@cogitator-ai/voice';

const openingHours = tool({
  name: 'get_opening_hours',
  description: 'Opening hours of the office for a given weekday',
  parameters: z.object({ day: z.string().describe('Weekday name') }),
  execute: async ({ day }) => ({
    day,
    open: '09:00',
    close: day.toLowerCase() === 'friday' ? '15:00' : '18:00',
  }),
});

const bookRoom = tool({
  name: 'book_meeting_room',
  description: 'Book the meeting room for a weekday',
  parameters: z.object({ day: z.string().describe('Weekday name') }),
  requiresApproval: true,
  execute: async ({ day }) => ({ booked: day }),
});

async function main() {
  header('04 — Realtime Voice Agent (Gemini Live over WebSocket)');

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.log('Set GOOGLE_API_KEY to run this example');
    process.exit(0);
  }

  section('1. Start a realtime VoiceAgent');
  const cogitator = new Cogitator();
  const concierge = new Agent({
    name: 'concierge',
    instructions: 'You are a concise voice concierge. Use tools when they help.',
    tools: [openingHours, bookRoom],
  });
  const voiceAgent = new VoiceAgent({
    mode: 'realtime',
    agent: createCogitatorRunner(cogitator, concierge),
    realtimeProvider: 'gemini',
    realtimeApiKey: apiKey,
    voice: 'Puck',
    agentTools: {
      onApproval: async (request) => {
        console.log(`  Approving ${request.toolName}(${JSON.stringify(request.arguments)})`);
        return { approved: true };
      },
    },
  });
  voiceAgent.on('error', (err) => console.error(`  Error: ${err.message}`));
  await voiceAgent.listen(0);
  console.log(`  Listening on ws://localhost:${voiceAgent.port}/voice`);

  section('2. Connect a client and ask by text');
  const client = new WebSocket(`ws://localhost:${voiceAgent.port}/voice`);
  let audioBytes = 0;
  const finished = new Promise<void>((resolve) => {
    client.on('message', (data, isBinary) => {
      if (isBinary) {
        audioBytes += (data as Buffer).length;
        return;
      }
      const event = JSON.parse(data.toString()) as { type: string; text?: string; role?: string };
      if (event.type === 'transcript') console.log(`  [${event.role}] ${event.text}`);
      if (event.type === 'turn_end' && audioBytes > 0) resolve();
    });
  });
  await new Promise<void>((resolve) => client.once('open', () => resolve()));

  client.send(
    JSON.stringify({
      type: 'text',
      text: 'When does the office close on Friday? Book the meeting room for that day too.',
    })
  );
  await Promise.race([finished, new Promise((r) => setTimeout(r, 30_000))]);

  console.log(`  Received ${audioBytes} bytes of PCM16 24kHz audio`);

  client.close();
  await voiceAgent.close();
  await cogitator.close();
  console.log('\nDone.');
}

void main();
