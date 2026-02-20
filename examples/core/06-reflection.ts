import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const stockPrices: Record<string, number> = {
  AAPL: 242.35,
  GOOGL: 191.18,
  MSFT: 432.67,
  TSLA: 348.94,
  AMZN: 228.68,
  NVDA: 137.71,
};

const getStockPrice = tool({
  name: 'get_stock_price',
  description: 'Get the current stock price for a ticker symbol',
  parameters: z.object({
    ticker: z.string().describe('Stock ticker symbol, e.g. AAPL'),
  }),
  execute: async ({ ticker }) => {
    const symbol = ticker.toUpperCase();
    const price = stockPrices[symbol];
    if (!price) {
      return {
        error: `Unknown ticker: ${symbol}. Available: ${Object.keys(stockPrices).join(', ')}`,
      };
    }
    return { ticker: symbol, price, currency: 'USD' };
  },
});

const getCompanyInfo = tool({
  name: 'get_company_info',
  description: 'Get basic company information for a ticker symbol',
  parameters: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
  }),
  execute: async ({ ticker }) => {
    const info: Record<string, { name: string; sector: string; marketCap: string }> = {
      AAPL: { name: 'Apple Inc.', sector: 'Technology', marketCap: '$3.7T' },
      GOOGL: { name: 'Alphabet Inc.', sector: 'Technology', marketCap: '$2.3T' },
      MSFT: { name: 'Microsoft Corp.', sector: 'Technology', marketCap: '$3.2T' },
      TSLA: { name: 'Tesla Inc.', sector: 'Automotive/Energy', marketCap: '$1.1T' },
      AMZN: { name: 'Amazon.com Inc.', sector: 'Consumer/Cloud', marketCap: '$2.4T' },
      NVDA: { name: 'NVIDIA Corp.', sector: 'Semiconductors', marketCap: '$3.4T' },
    };
    const symbol = ticker.toUpperCase();
    const data = info[symbol];
    if (!data) {
      return { error: `No info for ${symbol}` };
    }
    return { ticker: symbol, ...data };
  },
});

const calculateReturn = tool({
  name: 'calculate_return',
  description: 'Calculate the return on investment given buy price, current price, and shares',
  parameters: z.object({
    buyPrice: z.number().describe('Price per share when bought'),
    currentPrice: z.number().describe('Current price per share'),
    shares: z.number().describe('Number of shares'),
  }),
  execute: async ({ buyPrice, currentPrice, shares }) => {
    const invested = buyPrice * shares;
    const currentValue = currentPrice * shares;
    const profit = currentValue - invested;
    const returnPct = ((currentValue - invested) / invested) * 100;
    return {
      invested: +invested.toFixed(2),
      currentValue: +currentValue.toFixed(2),
      profit: +profit.toFixed(2),
      returnPercent: +returnPct.toFixed(2),
    };
  },
});

async function main() {
  header('06 — Reflection');

  const cog = createCogitator({
    reflection: {
      enabled: true,
      reflectAfterToolCall: true,
      reflectAfterError: true,
      reflectAtEnd: true,
      storeInsights: true,
      minConfidenceToStore: 0.3,
      reflectionModel: DEFAULT_MODEL,
    },
  });

  const agent = new Agent({
    name: 'portfolio-analyst',
    model: DEFAULT_MODEL,
    instructions: `You are a portfolio analyst assistant. Use your tools to look up stock prices,
get company info, and calculate returns. Be precise with numbers and provide clear analysis.
When asked about multiple stocks, look them all up systematically.`,
    tools: [getStockPrice, getCompanyInfo, calculateReturn],
    temperature: 0.3,
    maxIterations: 15,
  });

  section('1. First run — portfolio analysis');

  const result1 = await cog.run(agent, {
    input:
      'I bought 50 shares of AAPL at $185 and 30 shares of NVDA at $95. ' +
      'What are my current returns on each position? Also get company info for both.',
  });

  console.log('Output:', result1.output);
  console.log('\nTool calls:', result1.toolCalls.map((tc) => tc.name).join(', '));

  if (result1.reflections?.length) {
    section('Reflections from run 1');
    for (const r of result1.reflections) {
      console.log(
        `  [${r.action.type}] success=${r.analysis.wasSuccessful} confidence=${r.analysis.confidence.toFixed(2)}`
      );
      console.log(`    Reasoning: ${r.analysis.reasoning.slice(0, 120)}...`);
      if (r.analysis.whatCouldImprove) {
        console.log(`    Improve: ${r.analysis.whatCouldImprove.slice(0, 120)}`);
      }
      if (r.insights.length > 0) {
        console.log(
          `    Insights: ${r.insights.map((i) => `[${i.type}] ${i.content.slice(0, 60)}`).join(', ')}`
        );
      }
    }
  }

  section('2. Second run — triggers error path');

  const result2 = await cog.run(agent, {
    input:
      'What is the stock price for AAPL and ZZZZ? Calculate my return if I bought 100 shares of AAPL at $200.',
  });

  console.log('Output:', result2.output);
  console.log('\nTool calls:', result2.toolCalls.map((tc) => tc.name).join(', '));

  if (result2.reflections?.length) {
    section('Reflections from run 2');
    for (const r of result2.reflections) {
      console.log(
        `  [${r.action.type}] success=${r.analysis.wasSuccessful} confidence=${r.analysis.confidence.toFixed(2)}`
      );
      if (r.action.toolName) {
        console.log(`    Tool: ${r.action.toolName}`);
      }
      console.log(`    Reasoning: ${r.analysis.reasoning.slice(0, 120)}...`);
    }
  }

  section('3. Accumulated insights');

  const insights = await cog.getInsights(agent.id);
  console.log(`  Total insights stored: ${insights.length}`);
  for (const insight of insights.slice(0, 10)) {
    console.log(
      `  [${insight.type}] (conf=${insight.confidence.toFixed(2)}) ${insight.content.slice(0, 100)}`
    );
  }

  section('4. Reflection summary');

  const summary = await cog.getReflectionSummary(agent.id);
  if (summary) {
    console.log(`  Total reflections: ${summary.totalReflections}`);
    console.log(`  Success rate:      ${(summary.successRate * 100).toFixed(0)}%`);
    console.log(`  Avg confidence:    ${summary.averageConfidence.toFixed(2)}`);

    if (summary.learnedPatterns.length > 0) {
      console.log(`\n  Learned patterns:`);
      for (const p of summary.learnedPatterns) {
        console.log(`    - ${p.slice(0, 100)}`);
      }
    }

    if (summary.commonMistakes.length > 0) {
      console.log(`\n  Common mistakes:`);
      for (const m of summary.commonMistakes) {
        console.log(`    - ${m.slice(0, 100)}`);
      }
    }
  }

  if (result2.reflectionSummary) {
    section('5. Inline reflection summary (from RunResult)');
    const rs = result2.reflectionSummary;
    console.log(`  Total reflections: ${rs.totalReflections}`);
    console.log(`  Top insights: ${rs.topInsights.length}`);
    for (const ti of rs.topInsights.slice(0, 5)) {
      console.log(`    [${ti.type}] ${ti.content.slice(0, 80)}`);
    }
  }

  await cog.close();
  console.log('\nDone.');
}

main();
