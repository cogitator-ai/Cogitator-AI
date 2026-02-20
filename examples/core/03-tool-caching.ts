import { header, section } from '../_shared/setup.js';
import { tool, withCache } from '@cogitator-ai/core';
import { z } from 'zod';

interface WeatherData {
  city: string;
  temperature: number;
  humidity: number;
  condition: string;
  fetchedAt: string;
}

const weatherDatabase: Record<string, Omit<WeatherData, 'city' | 'fetchedAt'>> = {
  london: { temperature: 12, humidity: 85, condition: 'Overcast' },
  tokyo: { temperature: 22, humidity: 60, condition: 'Sunny' },
  'new york': { temperature: 8, humidity: 70, condition: 'Partly Cloudy' },
  sydney: { temperature: 28, humidity: 55, condition: 'Clear' },
  paris: { temperature: 14, humidity: 78, condition: 'Light Rain' },
};

let apiCallCount = 0;

const weatherLookup = tool({
  name: 'weather_lookup',
  description: 'Get current weather for a city',
  parameters: z.object({
    city: z.string().describe('City name'),
  }),
  execute: async ({ city }): Promise<WeatherData> => {
    apiCallCount++;
    await new Promise((r) => setTimeout(r, 50));

    const key = city.toLowerCase();
    const data = weatherDatabase[key];
    if (!data) {
      throw new Error(`Unknown city: ${city}`);
    }
    return { city, ...data, fetchedAt: new Date().toISOString() };
  },
});

const ctx = {
  agentId: 'demo',
  runId: 'cache-demo',
  signal: new AbortController().signal,
};

async function main() {
  header('03 — Tool Caching with withCache');

  const cachedWeather = withCache(weatherLookup, {
    strategy: 'exact',
    ttl: '5m',
    storage: 'memory',
    maxSize: 50,
    onHit: (_key, params) => {
      const { city } = params as { city: string };
      console.log(`  [CACHE HIT]  ${city}`);
    },
    onMiss: (_key, params) => {
      const { city } = params as { city: string };
      console.log(`  [CACHE MISS] ${city} — calling API`);
    },
  });

  section('1. First calls — all misses');
  const cities = ['London', 'Tokyo', 'New York'];
  for (const city of cities) {
    const result = await cachedWeather.execute({ city }, ctx);
    console.log(`  ${result.city}: ${result.temperature}°C, ${result.condition}`);
  }
  console.log(`\n  API calls so far: ${apiCallCount}`);

  section('2. Repeat calls — all hits');
  for (const city of cities) {
    const result = await cachedWeather.execute({ city }, ctx);
    console.log(`  ${result.city}: ${result.temperature}°C, ${result.condition}`);
  }
  console.log(`\n  API calls so far: ${apiCallCount} (unchanged)`);

  section('3. Cache statistics');
  const stats = cachedWeather.cache.stats();
  console.log(`  Entries:    ${stats.size}`);
  console.log(`  Hits:       ${stats.hits}`);
  console.log(`  Misses:     ${stats.misses}`);
  console.log(`  Hit rate:   ${(stats.hitRate * 100).toFixed(1)}%`);
  console.log(`  Evictions:  ${stats.evictions}`);

  section('4. Invalidate a specific entry');
  const removed = await cachedWeather.cache.invalidate({ city: 'Tokyo' });
  console.log(`  Invalidated "Tokyo": ${removed}`);

  console.log('\n  Fetching Tokyo again:');
  await cachedWeather.execute({ city: 'Tokyo' }, ctx);
  console.log(`  API calls now: ${apiCallCount}`);

  const statsAfter = cachedWeather.cache.stats();
  console.log(`\n  Updated stats:`);
  console.log(`  Hits:       ${statsAfter.hits}`);
  console.log(`  Misses:     ${statsAfter.misses}`);
  console.log(`  Hit rate:   ${(statsAfter.hitRate * 100).toFixed(1)}%`);

  section('5. Cache warmup');
  const freshCache = withCache(weatherLookup, {
    strategy: 'exact',
    ttl: '5m',
    storage: 'memory',
    maxSize: 50,
  });

  await freshCache.cache.warmup([
    {
      params: { city: 'Sydney' },
      result: {
        city: 'Sydney',
        temperature: 28,
        humidity: 55,
        condition: 'Clear',
        fetchedAt: new Date().toISOString(),
      },
    },
    {
      params: { city: 'Paris' },
      result: {
        city: 'Paris',
        temperature: 14,
        humidity: 78,
        condition: 'Light Rain',
        fetchedAt: new Date().toISOString(),
      },
    },
  ]);

  const callsBefore = apiCallCount;
  const sydney = await freshCache.execute({ city: 'Sydney' }, ctx);
  const paris = await freshCache.execute({ city: 'Paris' }, ctx);
  console.log(`  Sydney (warmed up): ${sydney.temperature}°C`);
  console.log(`  Paris (warmed up):  ${paris.temperature}°C`);
  console.log(
    `  API calls during warmup reads: ${apiCallCount - callsBefore} (zero — served from cache)`
  );

  section('6. Clear entire cache');
  await cachedWeather.cache.clear();
  const clearedStats = cachedWeather.cache.stats();
  console.log(`  Entries after clear: ${clearedStats.size}`);

  console.log('\nDone.');
}

main();
