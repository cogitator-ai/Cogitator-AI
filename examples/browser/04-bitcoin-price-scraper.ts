import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { BrowserSession, browserTools } from '@cogitator-ai/browser';

async function main() {
  header('04 — Bitcoin Price Scraper (Binance)');

  const session = new BrowserSession({ headless: true });
  await session.start();

  section('1. Create price scraper agent');
  const agent = new Agent({
    name: 'crypto-scraper',
    model: DEFAULT_MODEL,
    instructions: `You are a cryptocurrency price scraper agent.
Your job is to navigate to exchange websites and extract current price data.
Use browser_navigate to go to pages, then extraction tools to get the data.
Return the data in a clean, structured format with the trading pair, price, and 24h change.`,
    tools: browserTools(session, { modules: ['navigation', 'extraction'] }),
    temperature: 0,
    maxIterations: 15,
  });

  const cog = createCogitator();

  section('2. Scrape BTC/USDT price from Binance');
  const result = await cog.run(agent, {
    input: `Go to https://www.binance.com/en/trade/BTC_USDT and extract:
1. The current BTC/USDT price
2. The 24h price change (percentage)
3. The 24h high and low prices
4. The 24h trading volume

If the main trading page is hard to parse, try https://www.binance.com/en/price/bitcoin instead.
Return the data in a structured format.`,
  });

  console.log('BTC Price Data:');
  console.log(result.output);
  console.log('\nTools used:', result.toolCalls.map((tc) => tc.name).join(', '));

  section('3. Scrape top 5 crypto prices');
  const result2 = await cog.run(agent, {
    input: `Go to https://www.binance.com/en/markets/overview and extract the top 5 cryptocurrencies
by market cap with their names, prices, and 24h change percentages.
Return as a formatted table.`,
  });

  console.log('Top 5 Cryptos:');
  console.log(result2.output);

  await session.close();
  await cog.close();
  console.log('\nDone.');
}

main();
