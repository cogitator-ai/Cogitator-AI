import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, createLLMBackend, tool } from '@cogitator-ai/core';
import {
  SelfModifyingAgent,
  GapAnalyzer,
  ToolGenerator,
  InMemoryGeneratedToolStore,
  RollbackManager,
  ModificationValidator,
  DEFAULT_SAFETY_CONSTRAINTS,
  DEFAULT_CAPABILITY_CONSTRAINTS,
  DEFAULT_RESOURCE_CONSTRAINTS,
} from '@cogitator-ai/self-modifying';
import { z } from 'zod';

const fetchWeather = tool({
  name: 'fetch_weather',
  description: 'Fetch current weather for a city',
  parameters: z.object({
    city: z.string().describe('City name'),
  }),
  execute: async ({ city }) => ({
    city,
    temperature: 22,
    condition: 'partly cloudy',
    humidity: 65,
  }),
});

async function main() {
  header('01 — Self-Modifying Agent');

  const cog = createCogitator();
  const llm = createLLMBackend('google', {
    defaultProvider: 'google',
    providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
  });

  const agent = new Agent({
    name: 'adaptive-assistant',
    model: DEFAULT_MODEL,
    instructions: `You are a helpful assistant that can fetch weather data.
When you lack a tool for a task, explain what capability is missing.`,
    tools: [fetchWeather],
    temperature: 0.3,
    maxIterations: 5,
  });

  section('1. Gap analysis — what tools are we missing?');

  const gapAnalyzer = new GapAnalyzer({
    llm,
    config: {
      enabled: true,
      autoGenerate: true,
      maxToolsPerSession: 3,
      minConfidenceForGeneration: 0.5,
      maxIterationsPerTool: 3,
      requireLLMValidation: true,
      sandboxConfig: {
        enabled: true,
        maxExecutionTime: 5000,
        maxMemory: 50 * 1024 * 1024,
        allowedModules: [],
        isolationLevel: 'strict',
      },
    },
  });

  const analysis = await gapAnalyzer.analyze(
    'Calculate the wind chill factor given the temperature and wind speed, then convert to Fahrenheit',
    [fetchWeather]
  );

  console.log('  Intent coverage:', analysis.analysis.intentCoverage.toFixed(2));
  console.log('  Can proceed with existing tools:', analysis.analysis.canProceedWithExisting);
  console.log('  Gaps found:', analysis.gaps.length);

  for (const gap of analysis.gaps) {
    console.log(`    - ${gap.suggestedToolName}: ${gap.description}`);
    console.log(`      Confidence: ${(gap.confidence * 100).toFixed(0)}%`);
    console.log(`      Complexity: ${gap.complexity}`);
  }

  if (analysis.analysis.suggestedCompositions.length > 0) {
    console.log('  Suggested compositions:');
    for (const comp of analysis.analysis.suggestedCompositions) {
      console.log(`    - ${comp.description}`);
    }
  }

  section('2. Tool generation from identified gaps');

  const toolStore = new InMemoryGeneratedToolStore();
  const toolGenerator = new ToolGenerator({
    llm,
    config: {
      enabled: true,
      autoGenerate: true,
      maxToolsPerSession: 3,
      minConfidenceForGeneration: 0.5,
      maxIterationsPerTool: 3,
      requireLLMValidation: true,
      sandboxConfig: {
        enabled: true,
        maxExecutionTime: 5000,
        maxMemory: 50 * 1024 * 1024,
        allowedModules: [],
        isolationLevel: 'strict',
      },
    },
  });

  for (const gap of analysis.gaps.slice(0, 2)) {
    console.log(`  Generating tool for gap: "${gap.suggestedToolName}"...`);
    const result = await toolGenerator.generate(gap, [fetchWeather]);

    if (result.success && result.tool) {
      await toolStore.save(result.tool);
      console.log(`    Generated: ${result.tool.name}`);
      console.log(`    Description: ${result.tool.description}`);
      console.log(`    Status: ${result.tool.status}`);
      console.log(`    Iterations: ${result.iterations}`);
    } else {
      console.log(`    Generation failed: ${result.error ?? 'unknown error'}`);
    }
  }

  const generatedTools = await toolStore.list({ status: 'active' });
  console.log(`\n  Total generated tools in store: ${generatedTools.length}`);

  section('3. Checkpoint and rollback safety');

  const rollbackManager = new RollbackManager({ maxCheckpoints: 5 });

  const checkpoint1 = await rollbackManager.createCheckpoint(
    'adaptive-assistant',
    { name: agent.name, model: DEFAULT_MODEL, instructions: agent.instructions },
    [fetchWeather],
    []
  );
  console.log(`  Checkpoint created: ${checkpoint1.id}`);
  console.log(`  Tools at checkpoint: ${checkpoint1.tools.length}`);

  const checkpoint2 = await rollbackManager.createCheckpoint(
    'adaptive-assistant',
    {
      name: agent.name,
      model: DEFAULT_MODEL,
      instructions: 'Updated instructions after evolution',
    },
    [fetchWeather],
    []
  );
  console.log(`  Checkpoint 2 created: ${checkpoint2.id}`);

  const restored = await rollbackManager.rollbackTo(checkpoint1.id);
  if (restored) {
    console.log(`  Rolled back to checkpoint ${checkpoint1.id}`);
    console.log(`  Restored config name: ${restored.agentConfig.name}`);
    console.log(`  Restored tools count: ${restored.tools.length}`);
  }

  section('4. Modification validation');

  const validator = new ModificationValidator({
    constraints: {
      safety: DEFAULT_SAFETY_CONSTRAINTS,
      capability: DEFAULT_CAPABILITY_CONSTRAINTS,
      resource: DEFAULT_RESOURCE_CONSTRAINTS,
    },
  });

  const safeModification = await validator.validate({
    type: 'config_change',
    target: 'architecture',
    changes: { temperature: 0.5, maxTokens: 4096 },
    reason: 'Optimize for creative tasks',
  });
  console.log('  Safe modification valid:', safeModification.valid);
  console.log('  Rollback required:', safeModification.rollbackRequired);

  if (safeModification.errors && safeModification.errors.length > 0) {
    console.log('  Errors:');
    for (const err of safeModification.errors) {
      console.log(`    - ${err}`);
    }
  }

  if (safeModification.warnings.length > 0) {
    console.log('  Warnings:');
    for (const warn of safeModification.warnings) {
      console.log(`    - ${warn}`);
    }
  }

  section('5. Full self-modifying agent run');

  const selfModAgent = new SelfModifyingAgent({
    agent,
    llm,
    config: {
      toolGeneration: {
        enabled: true,
        autoGenerate: true,
        maxToolsPerSession: 2,
        minConfidenceForGeneration: 0.6,
        maxIterationsPerTool: 2,
        requireLLMValidation: false,
        sandboxConfig: {
          enabled: true,
          maxExecutionTime: 5000,
          maxMemory: 50 * 1024 * 1024,
          allowedModules: [],
          isolationLevel: 'strict',
        },
      },
      metaReasoning: { enabled: true },
      architectureEvolution: { enabled: false },
      constraints: { enabled: true, autoRollback: true },
    },
  });

  selfModAgent.on('tool_generation_started', (event) => {
    console.log(`  [event] Tool generation started: ${event.data.gap.suggestedToolName}`);
  });

  selfModAgent.on('tool_generation_completed', (event) => {
    console.log(
      `  [event] Tool generation ${event.data.success ? 'succeeded' : 'failed'}: ${event.data.name}`
    );
  });

  selfModAgent.on('strategy_changed', (event) => {
    console.log(
      `  [event] Strategy: ${event.data.previousMode} -> ${event.data.newMode} (${event.data.reason})`
    );
  });

  const result = await selfModAgent.run('What is the weather in Tokyo?');

  console.log(`\n  Output: ${result.output.slice(0, 200)}`);
  console.log(`  Tools generated: ${result.toolsGenerated.length}`);
  console.log(`  Adaptations made: ${result.adaptationsMade.length}`);
  console.log(`  Final config model: ${result.finalConfig.model}`);
  console.log(`  Final config temperature: ${result.finalConfig.temperature}`);

  await cog.close();
  console.log('\nDone.');
}

main();
