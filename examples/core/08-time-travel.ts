import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, TimeTravel, InMemoryCheckpointStore, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const inventory: Record<string, number> = {
  wood: 100,
  stone: 80,
  iron: 30,
  gold: 5,
};

const recipes: Record<string, Record<string, number>> = {
  wooden_sword: { wood: 10 },
  stone_pickaxe: { wood: 5, stone: 15 },
  iron_armor: { iron: 20, wood: 5 },
  gold_ring: { gold: 2 },
  fortress_wall: { stone: 50, wood: 20, iron: 10 },
};

const checkInventory = tool({
  name: 'check_inventory',
  description: 'Check current inventory of materials',
  parameters: z.object({}),
  execute: async () => ({ ...inventory }),
});

const craft = tool({
  name: 'craft',
  description: 'Craft an item using materials from inventory',
  parameters: z.object({
    item: z
      .string()
      .describe('Item to craft: wooden_sword, stone_pickaxe, iron_armor, gold_ring, fortress_wall'),
  }),
  execute: async ({ item }) => {
    const recipe = recipes[item];
    if (!recipe) {
      return { error: `Unknown item: ${item}. Available: ${Object.keys(recipes).join(', ')}` };
    }

    for (const [material, amount] of Object.entries(recipe)) {
      if ((inventory[material] ?? 0) < amount) {
        return {
          error: `Not enough ${material}: need ${amount}, have ${inventory[material] ?? 0}`,
          recipe,
        };
      }
    }

    for (const [material, amount] of Object.entries(recipe)) {
      inventory[material] -= amount;
    }

    return { crafted: item, recipe, remainingInventory: { ...inventory } };
  },
});

const tradeResources = tool({
  name: 'trade_resources',
  description: 'Trade resources with a merchant. Sell one material and buy another.',
  parameters: z.object({
    sell: z.string().describe('Material to sell'),
    sellAmount: z.number().describe('Amount to sell'),
    buy: z.string().describe('Material to buy'),
    buyAmount: z.number().describe('Amount to receive'),
  }),
  execute: async ({ sell, sellAmount, buy, buyAmount }) => {
    if ((inventory[sell] ?? 0) < sellAmount) {
      return { error: `Not enough ${sell}: have ${inventory[sell] ?? 0}, need ${sellAmount}` };
    }
    inventory[sell] -= sellAmount;
    inventory[buy] = (inventory[buy] ?? 0) + buyAmount;
    return {
      sold: { [sell]: sellAmount },
      bought: { [buy]: buyAmount },
      inventory: { ...inventory },
    };
  },
});

async function main() {
  header('08 — Time Travel');

  const cog = createCogitator();
  const checkpointStore = new InMemoryCheckpointStore();
  const tt = new TimeTravel(cog, { checkpointStore });

  const agent = new Agent({
    name: 'crafter',
    model: DEFAULT_MODEL,
    instructions: `You are a game crafting assistant. You manage an inventory of materials and craft items.
Always check inventory first, then craft items as requested. Use trade_resources if you need materials you don't have enough of.
Available items to craft: wooden_sword, stone_pickaxe, iron_armor, gold_ring, fortress_wall.`,
    tools: [checkInventory, craft, tradeResources],
    temperature: 0.2,
    maxIterations: 10,
  });

  section('1. Running a multi-step crafting task');

  const result = await cog.run(agent, {
    input:
      'Check our inventory, then craft a stone_pickaxe and a wooden_sword. Report what we have left.',
  });

  console.log(`  Output: ${result.output.slice(0, 200)}`);
  console.log(`  Tool calls: ${result.toolCalls.map((tc) => tc.name).join(' → ')}`);
  console.log(`  Spans: ${result.trace.spans.length}`);

  section('2. Checkpointing every step');

  const checkpoints = await tt.checkpointAll(result, 'craft-session');

  console.log(`  Created ${checkpoints.length} checkpoints:`);
  for (const cp of checkpoints) {
    console.log(
      `    [${cp.stepIndex}] ${cp.id} label="${cp.label ?? 'none'}" messages=${cp.messages.length}`
    );
  }

  section('3. Listing checkpoints by trace');

  const traceId = result.trace.traceId;
  const listed = await tt.getCheckpoints(traceId);
  console.log(`  Found ${listed.length} checkpoints for trace ${traceId.slice(0, 16)}...`);

  section('4. Inspecting a specific checkpoint');

  if (checkpoints.length > 0) {
    const midpoint = checkpoints[Math.min(1, checkpoints.length - 1)];
    const loaded = await tt.getCheckpoint(midpoint.id);

    if (loaded) {
      console.log(`  Checkpoint: ${loaded.id}`);
      console.log(`  Step index: ${loaded.stepIndex}`);
      console.log(`  Messages:   ${loaded.messages.length}`);
      console.log(`  Label:      ${loaded.label}`);
      console.log(`  Pending tool calls: ${loaded.pendingToolCalls.length}`);
      if (loaded.pendingToolCalls.length > 0) {
        for (const tc of loaded.pendingToolCalls) {
          console.log(`    → ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 80)})`);
        }
      }
    }
  }

  section('5. Replaying from a checkpoint');

  if (checkpoints.length > 0) {
    const replayFrom = checkpoints[0];
    console.log(`  Replaying from checkpoint ${replayFrom.id} (step ${replayFrom.stepIndex})`);

    const replayResult = await tt.replay(agent, replayFrom.id, { mode: 'live' });

    console.log(`  Replay output: ${replayResult.output.slice(0, 200)}`);
    console.log(`  Steps replayed:  ${replayResult.stepsReplayed}`);
    console.log(`  Steps executed:  ${replayResult.stepsExecuted}`);
    console.log(`  Diverged at:     ${replayResult.divergedAt ?? 'same path'}`);
    console.log(`  Tool calls:      ${replayResult.toolCalls.map((tc) => tc.name).join(' → ')}`);
  }

  section('6. Forking with different input');

  if (checkpoints.length > 0) {
    const forkFrom = checkpoints[0];
    console.log(`  Forking from checkpoint ${forkFrom.id} (step ${forkFrom.stepIndex})`);
    console.log(`  New input: "Craft a gold_ring and an iron_armor instead"`);

    const forkResult = await tt.forkWithNewInput(
      agent,
      forkFrom.id,
      'Craft a gold_ring and an iron_armor instead. Check inventory first.',
      'alt-craft-path'
    );

    console.log(`\n  Fork ID: ${forkResult.forkId}`);
    console.log(`  Output:  ${forkResult.result.output.slice(0, 200)}`);
    console.log(`  Tool calls: ${forkResult.result.toolCalls.map((tc) => tc.name).join(' → ')}`);

    section('7. Comparing original vs fork');
    console.log(
      `  Original path: ${result.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments).slice(0, 40)})`).join(' → ')}`
    );
    console.log(
      `  Fork path:     ${forkResult.result.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments).slice(0, 40)})`).join(' → ')}`
    );
    console.log(`  Original output: ${result.output.slice(0, 120)}...`);
    console.log(`  Fork output:     ${forkResult.result.output.slice(0, 120)}...`);
  }

  await cog.close();
  console.log('\nDone.');
}

main();
