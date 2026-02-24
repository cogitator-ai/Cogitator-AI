import type {
  InstructionVersion,
  InstructionVersionStore,
  InstructionSource,
} from '@cogitator-ai/types';

export interface RollbackManagerConfig {
  store: InstructionVersionStore;
  maxVersionsToKeep?: number;
}

export interface RollbackResult {
  success: boolean;
  previousVersion: InstructionVersion | null;
  newVersion: InstructionVersion | null;
  message: string;
}

export class RollbackManager {
  private store: InstructionVersionStore;
  private maxVersionsToKeep: number;

  constructor(config: RollbackManagerConfig) {
    this.store = config.store;
    this.maxVersionsToKeep = config.maxVersionsToKeep ?? 20;
  }

  async getCurrentVersion(agentId: string): Promise<InstructionVersion | null> {
    return this.store.getCurrent(agentId);
  }

  async getVersionHistory(agentId: string, limit?: number): Promise<InstructionVersion[]> {
    return this.store.getHistory(agentId, limit ?? this.maxVersionsToKeep);
  }

  async getVersion(versionId: string): Promise<InstructionVersion | null> {
    return this.store.get(versionId);
  }

  async deployVersion(
    agentId: string,
    instructions: string,
    source: InstructionSource,
    sourceId?: string
  ): Promise<InstructionVersion> {
    const current = await this.store.getCurrent(agentId);

    if (current) {
      await this.store.retire(current.id);
    }

    const nextVersion = current ? current.version + 1 : 1;

    const newVersion = await this.store.save({
      agentId,
      version: nextVersion,
      instructions,
      source,
      sourceId,
      deployedAt: new Date(),
      metrics: {
        runCount: 0,
        avgScore: 0,
        successRate: 0,
        avgLatency: 0,
        totalCost: 0,
      },
      parentVersionId: current?.id,
    });

    await this.pruneOldVersions(agentId);

    return newVersion;
  }

  async rollbackTo(agentId: string, targetVersionId: string): Promise<RollbackResult> {
    const current = await this.store.getCurrent(agentId);
    const targetVersion = await this.store.get(targetVersionId);

    if (!current) {
      return {
        success: false,
        previousVersion: null,
        newVersion: null,
        message: 'No current version found',
      };
    }

    if (!targetVersion) {
      return {
        success: false,
        previousVersion: current,
        newVersion: null,
        message: `Target version ${targetVersionId} not found`,
      };
    }

    if (targetVersion.agentId !== agentId) {
      return {
        success: false,
        previousVersion: current,
        newVersion: null,
        message: 'Target version belongs to a different agent',
      };
    }

    const newVersion = await this.deployVersion(
      agentId,
      targetVersion.instructions,
      'rollback',
      targetVersion.id
    );

    return {
      success: true,
      previousVersion: current,
      newVersion,
      message: `Successfully rolled back from v${current.version} to v${newVersion.version} (based on v${targetVersion.version})`,
    };
  }

  async rollbackToPrevious(agentId: string): Promise<RollbackResult> {
    const history = await this.store.getHistory(agentId, 2);

    if (history.length < 2) {
      return {
        success: false,
        previousVersion: history[0] ?? null,
        newVersion: null,
        message: 'No previous version available for rollback',
      };
    }

    const previous = history[1];
    return this.rollbackTo(agentId, previous.id);
  }

  async recordMetrics(
    agentId: string,
    score: number,
    latency: number,
    cost: number,
    success: boolean
  ): Promise<void> {
    const current = await this.store.getCurrent(agentId);
    if (!current) return;

    const runCount = current.metrics.runCount + 1;
    const successCount = current.metrics.successRate * current.metrics.runCount + (success ? 1 : 0);
    const newSuccessRate = successCount / runCount;

    const totalScore = current.metrics.avgScore * current.metrics.runCount + score;
    const newAvgScore = totalScore / runCount;

    const totalLatency = current.metrics.avgLatency * current.metrics.runCount + latency;
    const newAvgLatency = totalLatency / runCount;

    const newTotalCost = current.metrics.totalCost + cost;

    await this.store.updateMetrics(current.id, {
      runCount,
      avgScore: newAvgScore,
      successRate: newSuccessRate,
      avgLatency: newAvgLatency,
      totalCost: newTotalCost,
    });
  }

  async compareVersions(
    versionId1: string,
    versionId2: string
  ): Promise<{
    v1: InstructionVersion;
    v2: InstructionVersion;
    comparison: {
      scoreDiff: number;
      latencyDiff: number;
      successRateDiff: number;
      recommendation: string;
    };
  } | null> {
    const v1 = await this.store.get(versionId1);
    const v2 = await this.store.get(versionId2);

    if (!v1 || !v2) {
      return null;
    }

    const scoreDiff = v2.metrics.avgScore - v1.metrics.avgScore;
    const latencyDiff = v2.metrics.avgLatency - v1.metrics.avgLatency;
    const successRateDiff = v2.metrics.successRate - v1.metrics.successRate;

    let recommendation: string;

    if (v1.metrics.runCount < 10 || v2.metrics.runCount < 10) {
      recommendation = 'Insufficient data for meaningful comparison';
    } else if (scoreDiff > 0.05 && successRateDiff >= 0) {
      recommendation = `v${v2.version} performs better with ${(scoreDiff * 100).toFixed(1)}% higher score`;
    } else if (scoreDiff < -0.05 && successRateDiff <= 0) {
      recommendation = `v${v1.version} performs better with ${(-scoreDiff * 100).toFixed(1)}% higher score`;
    } else if (latencyDiff < 0 && Math.abs(scoreDiff) < 0.02) {
      recommendation = `v${v2.version} is faster with similar quality`;
    } else if (latencyDiff > 0 && Math.abs(scoreDiff) < 0.02) {
      recommendation = `v${v1.version} is faster with similar quality`;
    } else {
      recommendation = 'Performance is comparable between versions';
    }

    return {
      v1,
      v2,
      comparison: {
        scoreDiff,
        latencyDiff,
        successRateDiff,
        recommendation,
      },
    };
  }

  async findBestVersion(agentId: string): Promise<InstructionVersion | null> {
    const history = await this.store.getHistory(agentId, this.maxVersionsToKeep);

    if (history.length === 0) {
      return null;
    }

    const versionsWithEnoughData = history.filter((v) => v.metrics.runCount >= 10);

    if (versionsWithEnoughData.length === 0) {
      return history[0];
    }

    return versionsWithEnoughData.reduce((best, current) => {
      const currentWeightedScore = current.metrics.avgScore * current.metrics.successRate;
      const bestWeightedScore = best.metrics.avgScore * best.metrics.successRate;
      return currentWeightedScore > bestWeightedScore ? current : best;
    });
  }

  private async pruneOldVersions(agentId: string): Promise<void> {
    const history = await this.store.getHistory(agentId, this.maxVersionsToKeep + 10);

    if (history.length <= this.maxVersionsToKeep) {
      return;
    }

    const toRetire = history.slice(this.maxVersionsToKeep);
    for (const version of toRetire) {
      if (!version.retiredAt) {
        await this.store.retire(version.id);
      }
    }
  }
}
