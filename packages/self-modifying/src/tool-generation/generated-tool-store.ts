import type { GeneratedTool, GeneratedToolStore as IGeneratedToolStore } from '@cogitator-ai/types';

export interface ToolUsageRecord {
  toolId: string;
  timestamp: Date;
  success: boolean;
  executionTime: number;
  inputSummary?: string;
  error?: string;
}

export interface ToolMetrics {
  totalUsage: number;
  successCount: number;
  failureCount: number;
  averageExecutionTime: number;
  lastUsed: Date | null;
  successRate: number;
}

export class InMemoryGeneratedToolStore implements IGeneratedToolStore {
  private readonly tools = new Map<string, GeneratedTool>();
  private readonly usageRecords = new Map<string, ToolUsageRecord[]>();
  private readonly maxUsageRecordsPerTool = 1000;

  async save(tool: GeneratedTool): Promise<void> {
    const existing = this.tools.get(tool.id);
    const version = existing ? existing.version + 1 : tool.version;
    this.tools.set(tool.id, { ...tool, version, updatedAt: new Date() });
  }

  async get(id: string): Promise<GeneratedTool | null> {
    return this.tools.get(id) || null;
  }

  async getByName(name: string): Promise<GeneratedTool | null> {
    for (const tool of this.tools.values()) {
      if (tool.name === name && tool.status !== 'deprecated') {
        return tool;
      }
    }
    return null;
  }

  async list(filter?: {
    status?: GeneratedTool['status'];
    minScore?: number;
  }): Promise<GeneratedTool[]> {
    let tools = Array.from(this.tools.values());

    if (filter?.status) {
      tools = tools.filter((t) => t.status === filter.status);
    }

    if (filter?.minScore !== undefined) {
      tools = tools.filter(
        (t) => t.validationScore !== undefined && t.validationScore >= filter.minScore!
      );
    }

    return tools.sort((a, b) => {
      const scoreA = a.validationScore ?? 0;
      const scoreB = b.validationScore ?? 0;
      return scoreB - scoreA;
    });
  }

  async delete(id: string): Promise<boolean> {
    const deleted = this.tools.delete(id);
    this.usageRecords.delete(id);
    return deleted;
  }

  async updateStatus(id: string, status: GeneratedTool['status']): Promise<boolean> {
    const tool = this.tools.get(id);
    if (!tool) return false;

    tool.status = status;
    tool.updatedAt = new Date();
    return true;
  }

  async recordUsage(record: ToolUsageRecord): Promise<void> {
    const records = this.usageRecords.get(record.toolId) || [];
    records.push(record);

    if (records.length > this.maxUsageRecordsPerTool) {
      records.splice(0, records.length - this.maxUsageRecordsPerTool);
    }

    this.usageRecords.set(record.toolId, records);

    const tool = this.tools.get(record.toolId);
    if (tool) {
      tool.usageCount = (tool.usageCount || 0) + 1;
      tool.lastUsed = record.timestamp;
    }
  }

  async getMetrics(toolId: string): Promise<ToolMetrics | null> {
    const records = this.usageRecords.get(toolId);
    if (!records || records.length === 0) {
      return null;
    }

    const successCount = records.filter((r) => r.success).length;
    const totalTime = records.reduce((sum, r) => sum + r.executionTime, 0);

    return {
      totalUsage: records.length,
      successCount,
      failureCount: records.length - successCount,
      averageExecutionTime: totalTime / records.length,
      lastUsed: records.length > 0 ? records[records.length - 1].timestamp : null,
      successRate: successCount / records.length,
    };
  }

  async getTopTools(
    limit: number = 10
  ): Promise<Array<{ tool: GeneratedTool; metrics: ToolMetrics }>> {
    const result: Array<{ tool: GeneratedTool; metrics: ToolMetrics }> = [];

    for (const tool of this.tools.values()) {
      if (tool.status !== 'active') continue;

      const metrics = await this.getMetrics(tool.id);
      if (metrics && metrics.totalUsage > 0) {
        result.push({ tool, metrics });
      }
    }

    return result
      .sort((a, b) => {
        const scoreA = a.metrics.successRate * Math.log(a.metrics.totalUsage + 1);
        const scoreB = b.metrics.successRate * Math.log(b.metrics.totalUsage + 1);
        return scoreB - scoreA;
      })
      .slice(0, limit);
  }

  async findSimilar(description: string, limit: number = 5): Promise<GeneratedTool[]> {
    const descWords = new Set(description.toLowerCase().split(/\s+/));
    const scored: Array<{ tool: GeneratedTool; score: number }> = [];

    for (const tool of this.tools.values()) {
      if (tool.status === 'deprecated') continue;

      const toolWords = new Set(`${tool.name} ${tool.description}`.toLowerCase().split(/\s+/));

      let matchCount = 0;
      for (const word of descWords) {
        if (word.length >= 3 && toolWords.has(word)) {
          matchCount++;
        }
      }

      if (matchCount > 0) {
        scored.push({
          tool,
          score: matchCount / Math.max(descWords.size, toolWords.size),
        });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.tool);
  }

  async promoteToActive(toolId: string): Promise<boolean> {
    const tool = this.tools.get(toolId);
    if (!tool) return false;

    if (tool.status !== 'validated') {
      return false;
    }

    tool.status = 'active';
    tool.updatedAt = new Date();
    return true;
  }

  async deprecate(toolId: string, reason?: string): Promise<boolean> {
    const tool = this.tools.get(toolId);
    if (!tool) return false;

    tool.status = 'deprecated';
    tool.metadata = {
      ...tool.metadata,
      deprecationReason: reason,
      deprecatedAt: new Date().toISOString(),
    };
    tool.updatedAt = new Date();
    return true;
  }

  async cleanup(options: {
    maxAge?: number;
    minUsage?: number;
    maxDeprecated?: number;
  }): Promise<number> {
    let removed = 0;
    const now = Date.now();

    for (const [id, tool] of this.tools) {
      if (options.maxAge && tool.createdAt) {
        const age = now - tool.createdAt.getTime();
        if (age > options.maxAge && tool.status !== 'active') {
          this.tools.delete(id);
          this.usageRecords.delete(id);
          removed++;
          continue;
        }
      }

      if (options.minUsage !== undefined) {
        const usage = tool.usageCount || 0;
        if (usage < options.minUsage && tool.status === 'deprecated') {
          this.tools.delete(id);
          this.usageRecords.delete(id);
          removed++;
        }
      }
    }

    if (options.maxDeprecated !== undefined) {
      const deprecated = Array.from(this.tools.values())
        .filter((t) => t.status === 'deprecated')
        .sort((a, b) => (a.usageCount || 0) - (b.usageCount || 0));

      while (deprecated.length > options.maxDeprecated) {
        const toRemove = deprecated.shift()!;
        this.tools.delete(toRemove.id);
        this.usageRecords.delete(toRemove.id);
        removed++;
      }
    }

    return removed;
  }

  getStats(): {
    total: number;
    byStatus: Record<string, number>;
    totalUsage: number;
  } {
    const byStatus: Record<string, number> = {};
    let totalUsage = 0;

    for (const tool of this.tools.values()) {
      byStatus[tool.status] = (byStatus[tool.status] || 0) + 1;
      totalUsage += tool.usageCount || 0;
    }

    return {
      total: this.tools.size,
      byStatus,
      totalUsage,
    };
  }
}
