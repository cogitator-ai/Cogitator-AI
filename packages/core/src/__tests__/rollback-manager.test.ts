import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RollbackManager } from '../learning/rollback-manager';
import type {
  InstructionVersionStore,
  InstructionVersion,
  InstructionVersionMetrics,
} from '@cogitator-ai/types';

function makeVersion(overrides: Partial<InstructionVersion> = {}): InstructionVersion {
  return {
    id: `ver_${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'agent-1',
    version: 1,
    instructions: 'Be helpful',
    source: 'manual',
    deployedAt: new Date(),
    metrics: {
      runCount: 0,
      avgScore: 0,
      successRate: 0,
      avgLatency: 0,
      totalCost: 0,
    },
    ...overrides,
  };
}

function createMockStore(): InstructionVersionStore & {
  _versions: Map<string, InstructionVersion>;
} {
  const versions = new Map<string, InstructionVersion>();

  return {
    _versions: versions,

    get: vi.fn(async (id: string) => versions.get(id) ?? null),

    getCurrent: vi.fn(async (agentId: string) => {
      const agentVersions = [...versions.values()]
        .filter((v) => v.agentId === agentId && !v.retiredAt)
        .sort((a, b) => b.version - a.version);
      return agentVersions[0] ?? null;
    }),

    getHistory: vi.fn(async (agentId: string, limit: number) => {
      return [...versions.values()]
        .filter((v) => v.agentId === agentId)
        .sort((a, b) => b.version - a.version)
        .slice(0, limit);
    }),

    save: vi.fn(async (data: Omit<InstructionVersion, 'id'>) => {
      const id = `ver_${Math.random().toString(36).slice(2, 8)}`;
      const ver: InstructionVersion = { ...data, id };
      versions.set(id, ver);
      return ver;
    }),

    retire: vi.fn(async (id: string) => {
      const ver = versions.get(id);
      if (ver) ver.retiredAt = new Date();
    }),

    updateMetrics: vi.fn(async (id: string, metrics: Partial<InstructionVersionMetrics>) => {
      const ver = versions.get(id);
      if (ver) ver.metrics = { ...ver.metrics, ...metrics };
    }),
  };
}

describe('RollbackManager', () => {
  let store: ReturnType<typeof createMockStore>;
  let manager: RollbackManager;

  beforeEach(() => {
    store = createMockStore();
    manager = new RollbackManager({ store, maxVersionsToKeep: 5 });
  });

  describe('deployVersion', () => {
    it('deploys first version with version=1', async () => {
      const ver = await manager.deployVersion('agent-1', 'Be helpful', 'manual');

      expect(ver.agentId).toBe('agent-1');
      expect(ver.version).toBe(1);
      expect(ver.instructions).toBe('Be helpful');
      expect(ver.source).toBe('manual');
      expect(ver.metrics.runCount).toBe(0);
    });

    it('increments version number', async () => {
      await manager.deployVersion('agent-1', 'v1 instructions', 'manual');
      const v2 = await manager.deployVersion('agent-1', 'v2 instructions', 'optimization');

      expect(v2.version).toBe(2);
      expect(v2.instructions).toBe('v2 instructions');
    });

    it('retires current version on deploy', async () => {
      await manager.deployVersion('agent-1', 'v1', 'manual');
      await manager.deployVersion('agent-1', 'v2', 'manual');

      expect(store.retire).toHaveBeenCalledTimes(1);
    });

    it('sets parentVersionId', async () => {
      const v1 = await manager.deployVersion('agent-1', 'v1', 'manual');
      await manager.deployVersion('agent-1', 'v2', 'manual');

      const savedCalls = vi.mocked(store.save).mock.calls;
      const v2SaveArg = savedCalls[1][0];
      expect(v2SaveArg.parentVersionId).toBe(v1.id);
    });
  });

  describe('rollbackTo', () => {
    it('rolls back to a target version', async () => {
      const v1 = await manager.deployVersion('agent-1', 'v1 instructions', 'manual');
      await manager.deployVersion('agent-1', 'v2 instructions', 'optimization');

      const result = await manager.rollbackTo('agent-1', v1.id);

      expect(result.success).toBe(true);
      expect(result.previousVersion).toBeTruthy();
      expect(result.newVersion).toBeTruthy();
      expect(result.newVersion!.instructions).toBe('v1 instructions');
      expect(result.newVersion!.source).toBe('rollback');
      expect(result.message).toContain('Successfully rolled back');
    });

    it('fails if no current version', async () => {
      const result = await manager.rollbackTo('agent-1', 'nonexistent');

      expect(result.success).toBe(false);
      expect(result.previousVersion).toBeNull();
      expect(result.newVersion).toBeNull();
      expect(result.message).toBe('No current version found');
    });

    it('fails if target version not found', async () => {
      await manager.deployVersion('agent-1', 'v1', 'manual');

      const result = await manager.rollbackTo('agent-1', 'nonexistent');

      expect(result.success).toBe(false);
      expect(result.newVersion).toBeNull();
      expect(result.message).toContain('not found');
    });

    it('fails if target belongs to different agent', async () => {
      await manager.deployVersion('agent-1', 'v1', 'manual');
      const otherVer = makeVersion({ agentId: 'agent-2' });
      store._versions.set(otherVer.id, otherVer);

      const result = await manager.rollbackTo('agent-1', otherVer.id);

      expect(result.success).toBe(false);
      expect(result.message).toContain('different agent');
    });
  });

  describe('rollbackToPrevious', () => {
    it('rolls back to previous version', async () => {
      await manager.deployVersion('agent-1', 'v1 instructions', 'manual');
      await manager.deployVersion('agent-1', 'v2 instructions', 'optimization');

      const result = await manager.rollbackToPrevious('agent-1');

      expect(result.success).toBe(true);
      expect(result.newVersion!.instructions).toBe('v1 instructions');
    });

    it('fails when no previous version exists', async () => {
      await manager.deployVersion('agent-1', 'v1', 'manual');

      const result = await manager.rollbackToPrevious('agent-1');

      expect(result.success).toBe(false);
      expect(result.message).toContain('No previous version');
    });

    it('fails with empty history', async () => {
      const result = await manager.rollbackToPrevious('agent-1');

      expect(result.success).toBe(false);
      expect(result.previousVersion).toBeNull();
    });
  });

  describe('recordMetrics', () => {
    it('updates running averages correctly', async () => {
      await manager.deployVersion('agent-1', 'v1', 'manual');

      await manager.recordMetrics('agent-1', 0.8, 100, 0.01, true);
      await manager.recordMetrics('agent-1', 0.6, 200, 0.02, false);

      expect(store.updateMetrics).toHaveBeenCalledTimes(2);

      const lastCall = vi.mocked(store.updateMetrics).mock.calls[1][1];
      expect(lastCall.runCount).toBe(2);
      expect(lastCall.avgScore).toBeCloseTo(0.7, 5);
      expect(lastCall.avgLatency).toBeCloseTo(150, 5);
      expect(lastCall.successRate).toBeCloseTo(0.5, 5);
      expect(lastCall.totalCost).toBeCloseTo(0.03, 5);
    });

    it('does nothing if no current version', async () => {
      await manager.recordMetrics('agent-1', 0.8, 100, 0.01, true);

      expect(store.updateMetrics).not.toHaveBeenCalled();
    });
  });

  describe('compareVersions', () => {
    it('compares two versions with sufficient data', async () => {
      const v1 = makeVersion({
        version: 1,
        metrics: { runCount: 20, avgScore: 0.7, successRate: 0.8, avgLatency: 200, totalCost: 1 },
      });
      const v2 = makeVersion({
        version: 2,
        metrics: { runCount: 20, avgScore: 0.9, successRate: 0.9, avgLatency: 150, totalCost: 1.5 },
      });
      store._versions.set(v1.id, v1);
      store._versions.set(v2.id, v2);

      const result = await manager.compareVersions(v1.id, v2.id);

      expect(result).not.toBeNull();
      expect(result!.comparison.scoreDiff).toBeCloseTo(0.2, 5);
      expect(result!.comparison.latencyDiff).toBeCloseTo(-50, 5);
      expect(result!.comparison.recommendation).toContain('v2 performs better');
    });

    it('returns insufficient data recommendation', async () => {
      const v1 = makeVersion({
        version: 1,
        metrics: { runCount: 5, avgScore: 0.7, successRate: 0.8, avgLatency: 200, totalCost: 0.5 },
      });
      const v2 = makeVersion({
        version: 2,
        metrics: { runCount: 5, avgScore: 0.9, successRate: 0.9, avgLatency: 150, totalCost: 0.5 },
      });
      store._versions.set(v1.id, v1);
      store._versions.set(v2.id, v2);

      const result = await manager.compareVersions(v1.id, v2.id);

      expect(result!.comparison.recommendation).toContain('Insufficient data');
    });

    it('returns null if version not found', async () => {
      const result = await manager.compareVersions('no-id', 'no-id-2');

      expect(result).toBeNull();
    });

    it('recommends v1 when it has higher score', async () => {
      const v1 = makeVersion({
        version: 1,
        metrics: { runCount: 20, avgScore: 0.9, successRate: 0.9, avgLatency: 200, totalCost: 1 },
      });
      const v2 = makeVersion({
        version: 2,
        metrics: { runCount: 20, avgScore: 0.7, successRate: 0.8, avgLatency: 200, totalCost: 1 },
      });
      store._versions.set(v1.id, v1);
      store._versions.set(v2.id, v2);

      const result = await manager.compareVersions(v1.id, v2.id);

      expect(result!.comparison.recommendation).toContain('v1 performs better');
    });

    it('recommends faster version when scores are similar', async () => {
      const v1 = makeVersion({
        version: 1,
        metrics: { runCount: 20, avgScore: 0.8, successRate: 0.9, avgLatency: 300, totalCost: 1 },
      });
      const v2 = makeVersion({
        version: 2,
        metrics: { runCount: 20, avgScore: 0.8, successRate: 0.9, avgLatency: 150, totalCost: 1 },
      });
      store._versions.set(v1.id, v1);
      store._versions.set(v2.id, v2);

      const result = await manager.compareVersions(v1.id, v2.id);

      expect(result!.comparison.recommendation).toContain('faster');
    });
  });

  describe('findBestVersion', () => {
    it('returns best version by weighted score', async () => {
      const v1 = makeVersion({
        agentId: 'agent-1',
        version: 1,
        metrics: { runCount: 20, avgScore: 0.7, successRate: 0.8, avgLatency: 200, totalCost: 1 },
      });
      const v2 = makeVersion({
        agentId: 'agent-1',
        version: 2,
        metrics: {
          runCount: 20,
          avgScore: 0.9,
          successRate: 0.95,
          avgLatency: 150,
          totalCost: 1.5,
        },
      });
      store._versions.set(v1.id, v1);
      store._versions.set(v2.id, v2);

      const best = await manager.findBestVersion('agent-1');

      expect(best).not.toBeNull();
      expect(best!.version).toBe(2);
    });

    it('returns first version when none have enough data', async () => {
      const v1 = makeVersion({
        agentId: 'agent-1',
        version: 1,
        metrics: { runCount: 3, avgScore: 0.5, successRate: 0.5, avgLatency: 200, totalCost: 0.1 },
      });
      store._versions.set(v1.id, v1);

      const best = await manager.findBestVersion('agent-1');

      expect(best).not.toBeNull();
      expect(best!.version).toBe(1);
    });

    it('returns null for empty history', async () => {
      const best = await manager.findBestVersion('agent-1');

      expect(best).toBeNull();
    });
  });

  describe('getCurrentVersion / getVersionHistory / getVersion', () => {
    it('delegates to store', async () => {
      await manager.getCurrentVersion('agent-1');
      expect(store.getCurrent).toHaveBeenCalledWith('agent-1');

      await manager.getVersionHistory('agent-1', 10);
      expect(store.getHistory).toHaveBeenCalledWith('agent-1', 10);

      await manager.getVersion('ver-123');
      expect(store.get).toHaveBeenCalledWith('ver-123');
    });

    it('uses maxVersionsToKeep as default limit', async () => {
      await manager.getVersionHistory('agent-1');
      expect(store.getHistory).toHaveBeenCalledWith('agent-1', 5);
    });
  });
});
