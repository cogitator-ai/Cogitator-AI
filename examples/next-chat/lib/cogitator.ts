import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

export const cogitator = new Cogitator({
  backend: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY || '',
  },
});

export const chatAgent = new Agent({
  name: 'chat-assistant',
  instructions: `You are a helpful AI assistant. You can help with general questions and use tools when needed.
Be concise but friendly in your responses.`,
  tools: [
    tool({
      name: 'get_weather',
      description: 'Get current weather for a location',
      parameters: z.object({
        location: z.string().describe('City name or location'),
      }),
      execute: async ({ location }) => {
        const temps: Record<string, number> = {
          'new york': 72,
          london: 58,
          tokyo: 68,
          paris: 64,
        };
        const temp = temps[location.toLowerCase()] ?? Math.floor(Math.random() * 30) + 50;
        return `Weather in ${location}: ${temp}°F, partly cloudy`;
      },
    }),
    tool({
      name: 'calculate',
      description: 'Perform a mathematical calculation',
      parameters: z.object({
        expression: z.string().describe('Math expression to evaluate'),
      }),
      execute: async ({ expression }) => {
        try {
          const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, '');
          const result = new Function(`return ${sanitized}`)();
          return `${expression} = ${result}`;
        } catch {
          return `Error: Could not evaluate "${expression}"`;
        }
      },
    }),
  ],
});

export const researchAgent = new Agent({
  name: 'research-assistant',
  instructions: `You are a research assistant. Analyze queries and provide detailed, well-structured responses.
Use available tools to gather information when needed.`,
  tools: [
    tool({
      name: 'search_web',
      description: 'Search the web for information',
      parameters: z.object({
        query: z.string().describe('Search query'),
      }),
      execute: async ({ query }) => {
        return `Search results for "${query}":\n1. Result about ${query} from Wikipedia\n2. Latest news about ${query}\n3. Academic papers on ${query}`;
      },
    }),
  ],
});
