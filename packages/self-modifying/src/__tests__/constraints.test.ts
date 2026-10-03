import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import type { AgentConfig, Tool } from '@cogitator-ai/types';
import {
  ModificationValidator,
  RollbackManager,
  InMemoryCheckpointStore,
  DEFAULT_SAFETY_CONSTRAINTS,
  mergeSafetyConstraints,
} from '../constraints';

function agentConfig(overrides: Partial<AgentConfig>): AgentConfig {
  return { name: 'agent', instructions: 'Test agent', ...overrides };
}

function makeTool(name: string, description: string): Tool {
  return {
    name,
    description,
    parameters: z.object({}),
    execute: async () => null,
    toJSON: () => ({ name, description, parameters: { type: 'object', properties: {} } }),
  };
}

describe('ModificationValidator', () => {
  let validator: ModificationValidator;

  beforeEach(() => {
    validator = new ModificationValidator();
  });

  it('validates safe modifications', async () => {
    const result = await validator.validate({
      type: 'config_change',
      target: 'temperature',
      changes: { temperature: 0.7 },
      reason: 'Adjust for creativity',
      payload: {
        sandboxExecution: true,
        linesOfCode: 50,
        modificationDepth: 1,
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects modifications violating safety constraints', async () => {
    const result = await validator.validate({
      type: 'tool_creation',
      target: 'new_tool',
      changes: { code: 'eval("malicious")' },
      reason: 'Create tool',
      payload: {
        sandboxExecution: false,
        linesOfCode: 50,
        modificationDepth: 1,
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('handles complex constraint expressions', async () => {
    const customValidator = new ModificationValidator({
      constraints: {
        safety: [
          {
            id: 'complex_rule',
            rule: 'temperature <= 1.5 AND maxTokens <= 8000',
            severity: 'error',
            description: 'Complex constraint',
          },
        ],
        capability: [],
        resource: [],
      },
    });

    const validResult = await customValidator.validate({
      type: 'config_change',
      target: 'config',
      changes: {},
      reason: 'Test',
      payload: {
        temperature: 1.0,
        maxTokens: 4000,
        sandboxExecution: true,
        linesOfCode: 50,
        modificationDepth: 1,
      },
    });

    expect(validResult.valid).toBe(true);

    const invalidResult = await customValidator.validate({
      type: 'config_change',
      target: 'config',
      changes: {},
      reason: 'Test',
      payload: {
        temperature: 2.0,
        maxTokens: 4000,
        sandboxExecution: true,
        linesOfCode: 50,
        modificationDepth: 1,
      },
    });

    expect(invalidResult.valid).toBe(false);
  });

  it('adds custom constraints', async () => {
    validator.addSafetyConstraint({
      id: 'custom_test',
      rule: 'customValue = true',
      severity: 'error',
      description: 'Custom test constraint',
    });

    const result = await validator.validate({
      type: 'config_change',
      target: 'test',
      changes: {},
      reason: 'Test',
      payload: {
        customValue: false,
        sandboxExecution: true,
        linesOfCode: 50,
        modificationDepth: 1,
      },
    });

    expect(result.valid).toBe(false);
  });
});

describe('RollbackManager', () => {
  let manager: RollbackManager;

  beforeEach(() => {
    manager = new RollbackManager({ maxCheckpoints: 10 });
  });

  it('creates checkpoints', async () => {
    const checkpoint = await manager.createCheckpoint(
      'agent-1',
      agentConfig({ model: 'gpt-4', temperature: 0.7 }),
      [makeTool('tool1', 'Test')],
      []
    );

    expect(checkpoint.id).toBeDefined();
    expect(checkpoint.agentId).toBe('agent-1');
    expect(checkpoint.agentConfig.model).toBe('gpt-4');
  });

  it('rolls back to checkpoint', async () => {
    const checkpoint = await manager.createCheckpoint(
      'agent-1',
      agentConfig({ model: 'gpt-4', temperature: 0.7 }),
      [makeTool('original_tool', 'Original')],
      []
    );

    const restored = await manager.rollbackTo(checkpoint.id);

    expect(restored).not.toBeNull();
    expect(restored?.agentConfig.model).toBe('gpt-4');
    expect(restored?.tools).toHaveLength(1);
    expect(restored?.tools[0].name).toBe('original_tool');
  });

  it('compares checkpoints', async () => {
    const cp1 = await manager.createCheckpoint(
      'agent-1',
      agentConfig({ model: 'gpt-4', temperature: 0.7 }),
      [makeTool('tool1', 'Test')],
      []
    );

    const cp2 = await manager.createCheckpoint(
      'agent-1',
      agentConfig({ model: 'gpt-4o', temperature: 0.9 }),
      [makeTool('tool1', 'Test'), makeTool('tool2', 'New')],
      []
    );

    const diff = manager.compareCheckpoints(cp1, cp2);

    expect(diff).not.toBeNull();
    expect(diff.configChanges.map((c) => c.key)).toContain('model');
    expect(diff.configChanges.map((c) => c.key)).toContain('temperature');
    expect(diff.toolsAdded).toContain('tool2');
  });

  it('maintains checkpoint limit', async () => {
    const customManager = new RollbackManager({ maxCheckpoints: 3 });

    for (let i = 0; i < 5; i++) {
      await customManager.createCheckpoint('agent-1', agentConfig({ name: `agent-${i}` }), [], []);
    }

    const checkpoints = await customManager.listCheckpoints('agent-1');
    expect(checkpoints.length).toBeLessThanOrEqual(3);
  });
});

describe('InMemoryCheckpointStore', () => {
  let store: InMemoryCheckpointStore;

  beforeEach(() => {
    store = new InMemoryCheckpointStore();
  });

  it('saves and retrieves checkpoints', async () => {
    const checkpoint = {
      id: 'cp-1',
      agentId: 'agent-1',
      timestamp: new Date(),
      agentConfig: { model: 'test' },
      tools: [],
      modifications: [],
    };

    await store.save(checkpoint);
    const retrieved = await store.get('cp-1');

    expect(retrieved).toEqual(checkpoint);
  });

  it('lists checkpoints by agent', async () => {
    await store.save({
      id: 'cp-1',
      agentId: 'agent-1',
      timestamp: new Date(),
      agentConfig: {},
      tools: [],
      modifications: [],
    });

    await store.save({
      id: 'cp-2',
      agentId: 'agent-2',
      timestamp: new Date(),
      agentConfig: {},
      tools: [],
      modifications: [],
    });

    const agent1Checkpoints = await store.list('agent-1');
    expect(agent1Checkpoints).toHaveLength(1);
    expect(agent1Checkpoints[0].id).toBe('cp-1');
  });

  it('deletes checkpoints', async () => {
    await store.save({
      id: 'cp-1',
      agentId: 'agent-1',
      timestamp: new Date(),
      agentConfig: {},
      tools: [],
      modifications: [],
    });

    await store.delete('cp-1');
    const retrieved = await store.get('cp-1');

    expect(retrieved).toBeNull();
  });
});

describe('Constraint merging', () => {
  it('merges safety constraints', () => {
    const custom = [
      { id: 'custom', rule: 'x = 1', severity: 'error' as const, description: 'Custom' },
    ];

    const merged = mergeSafetyConstraints(DEFAULT_SAFETY_CONSTRAINTS, custom);

    expect(merged.length).toBeGreaterThan(custom.length);
    expect(merged.find((c) => c.id === 'custom')).toBeDefined();
  });
});
