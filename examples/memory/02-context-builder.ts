import { header, section } from '../_shared/setup.js';
import { InMemoryAdapter, ContextBuilder, countTokens } from '@cogitator-ai/memory';

async function main() {
  header('02 — Context Builder: Token-Aware Context Windows');

  const memory = new InMemoryAdapter();
  await memory.connect();

  const agentId = 'context-agent';
  const threadId = 'ctx-thread';
  await memory.createThread(agentId, {}, threadId);

  section('1. Populate a conversation');

  const conversation = [
    { role: 'user' as const, content: 'Hi! I want to plan a trip to Japan.' },
    {
      role: 'assistant' as const,
      content:
        'Great choice! Japan has amazing culture, food, and scenery. When are you planning to go, and what interests you most — cities, nature, or historical sites?',
    },
    {
      role: 'user' as const,
      content:
        'I want to go in April for cherry blossom season. I love both cities and nature. My budget is around $3000 for two weeks.',
    },
    {
      role: 'assistant' as const,
      content:
        'April is perfect for cherry blossoms! With $3000 for two weeks, I would suggest splitting time between Tokyo (4 days), Kyoto (3 days), Osaka (2 days), and a nature area like Hakone or the Japanese Alps (3 days). Would you like a detailed day-by-day itinerary?',
    },
    { role: 'user' as const, content: 'Yes please! Start with Tokyo.' },
    {
      role: 'assistant' as const,
      content:
        'Here is your Tokyo itinerary: Day 1 — Arrive at Narita, take the Narita Express to Shinjuku. Check into your hotel and explore Shinjuku Gyoen for evening cherry blossoms. Day 2 — Visit Senso-ji temple in Asakusa, then head to Akihabara for electronics and anime culture. Evening in Shibuya. Day 3 — Tsukiji Outer Market for breakfast, then Meiji Shrine and Harajuku. Afternoon in Roppongi Hills for city views. Day 4 — Day trip to Kamakura to see the Great Buddha, or explore Ueno Park and museums.',
    },
    {
      role: 'user' as const,
      content: 'That sounds amazing! What about Kyoto?',
    },
    {
      role: 'assistant' as const,
      content:
        'Kyoto plan: Day 5 — Take the Shinkansen from Tokyo to Kyoto (2.5 hours). Visit Fushimi Inari Shrine with its thousands of torii gates. Day 6 — Arashiyama bamboo grove in the morning, then Kinkaku-ji (Golden Pavilion) and Ryoan-ji rock garden. Day 7 — Visit Kiyomizu-dera temple, explore Gion district, and try a traditional tea ceremony.',
    },
    {
      role: 'user' as const,
      content: 'I also need to know about the Japan Rail Pass. Is it worth it?',
    },
    {
      role: 'assistant' as const,
      content:
        'Absolutely! A 14-day Japan Rail Pass costs about $420 and covers all JR trains including the Shinkansen (bullet train). For your itinerary covering Tokyo, Kyoto, Osaka, and Hakone, you would easily spend more than that on individual tickets. The pass also covers some JR buses and the ferry to Miyajima. Buy it online before your trip — you cannot purchase it in Japan.',
    },
    {
      role: 'user' as const,
      content: 'One more thing — any food recommendations?',
    },
    {
      role: 'assistant' as const,
      content:
        'Must-try foods: Ramen (try Ichiran in Tokyo), sushi at Tsukiji, okonomiyaki in Osaka, matcha desserts in Kyoto, takoyaki (octopus balls) from street vendors. Also try a conveyor belt sushi restaurant — it is fun and affordable! Budget about $30-50 per day for food if you mix convenience stores, ramen shops, and occasional sit-down meals.',
    },
  ];

  for (const msg of conversation) {
    await memory.addEntry({
      threadId,
      message: msg,
      tokenCount: countTokens(msg.content),
    });
  }

  console.log(`Added ${conversation.length} messages to thread`);
  console.log(
    'Total tokens:',
    conversation.reduce((sum, m) => sum + countTokens(m.content), 0)
  );

  section('2. Build context with large token budget (all messages fit)');

  const largeBuilder = new ContextBuilder(
    { maxTokens: 8000, strategy: 'recent' },
    { memoryAdapter: memory }
  );

  const fullContext = await largeBuilder.build({
    threadId,
    agentId,
    systemPrompt: 'You are a travel planning assistant.',
  });

  console.log('Messages included:', fullContext.metadata.includedMessageCount);
  console.log('Original messages:', fullContext.metadata.originalMessageCount);
  console.log('Token count:', fullContext.tokenCount);
  console.log('Truncated:', fullContext.truncated);

  section('3. Build context with small token budget (truncation happens)');

  const smallBuilder = new ContextBuilder(
    { maxTokens: 300, strategy: 'recent', reserveTokens: 50 },
    { memoryAdapter: memory }
  );

  const truncatedContext = await smallBuilder.build({
    threadId,
    agentId,
    systemPrompt: 'You are a travel planning assistant.',
  });

  console.log('Messages included:', truncatedContext.metadata.includedMessageCount);
  console.log('Original messages:', truncatedContext.metadata.originalMessageCount);
  console.log('Token count:', truncatedContext.tokenCount);
  console.log('Truncated:', truncatedContext.truncated);

  console.log('\nIncluded messages (most recent):');
  for (const msg of truncatedContext.messages) {
    const text = typeof msg.content === 'string' ? msg.content : '[multipart]';
    console.log(`  [${msg.role}] ${text.slice(0, 70)}${text.length > 70 ? '...' : ''}`);
  }

  section('4. Compare different token budgets');

  const budgets = [100, 200, 400, 800, 2000, 8000];

  console.log('Budget  | Included | Total | Truncated');
  console.log('--------|----------|-------|---------');

  for (const budget of budgets) {
    const builder = new ContextBuilder(
      { maxTokens: budget, strategy: 'recent' },
      { memoryAdapter: memory }
    );

    const ctx = await builder.build({ threadId, agentId });
    const included = ctx.metadata.includedMessageCount;
    const total = ctx.metadata.originalMessageCount;
    const padBudget = String(budget).padStart(5);
    const padIncluded = String(included).padStart(8);
    const padTotal = String(total).padStart(5);
    console.log(`${padBudget}   | ${padIncluded} | ${padTotal} | ${ctx.truncated}`);
  }

  section('5. System prompt takes priority');

  const longPromptBuilder = new ContextBuilder(
    { maxTokens: 150, strategy: 'recent', includeSystemPrompt: true },
    { memoryAdapter: memory }
  );

  const withPrompt = await longPromptBuilder.build({
    threadId,
    agentId,
    systemPrompt:
      'You are an expert Japan travel planner with 20 years of experience. You know every hidden gem, local restaurant, and off-the-beaten-path attraction.',
  });

  const withoutPromptBuilder = new ContextBuilder(
    { maxTokens: 150, strategy: 'recent', includeSystemPrompt: false },
    { memoryAdapter: memory }
  );

  const withoutPrompt = await withoutPromptBuilder.build({
    threadId,
    agentId,
    systemPrompt: 'Same long prompt here...',
  });

  console.log('With system prompt:');
  console.log('  Messages:', withPrompt.messages.length);
  console.log('  Tokens:', withPrompt.tokenCount);
  console.log('  Has system msg:', withPrompt.messages[0]?.role === 'system');

  console.log('Without system prompt:');
  console.log('  Messages:', withoutPrompt.messages.length);
  console.log('  Tokens:', withoutPrompt.tokenCount);
  console.log('  More room for history:', withoutPrompt.metadata.includedMessageCount, 'messages');

  await memory.disconnect();
  console.log('\nDone.');
}

main();
