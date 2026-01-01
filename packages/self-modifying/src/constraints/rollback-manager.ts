import { nanoid } from 'nanoid';
import type {
  ModificationCheckpoint,
  AppliedModification,
  AgentConfig,
  Tool,
} from '@cogitator-ai/types';

export interface CheckpointStore {
  save(checkpoint: ModificationCheckpoint): Promise<void>;
  get(id: string): Promise<ModificationCheckpoint | null>;
  list(agentId: string): Promise<ModificationCheckpoint[]>;
  delete(id: string): Promise<boolean>;
  prune(agentId: string, keepCount: number): Promise<number>;
}

export class InMemoryCheckpointStore implements CheckpointStore {
  private checkpoints = new Map<string, ModificationCheckpoint>();
  private agentIndex = new Map<string, Set<string>>();

  async save(checkpoint: ModificationCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.id, checkpoint);
    if (!this.agentIndex.has(checkpoint.agentId)) {
      this.agentIndex.set(checkpoint.agentId, new Set());
    }
    this.agentIndex.get(checkpoint.agentId)!.add(checkpoint.id);
  }

  async get(id: string): Promise<ModificationCheckpoint | null> {
    return this.checkpoints.get(id) ?? null;
  }

  async list(agentId: string): Promise<ModificationCheckpoint[]> {
    const ids = this.agentIndex.get(agentId);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.checkpoints.get(id)!)
      .filter(Boolean)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  async delete(id: string): Promise<boolean> {
    const checkpoint = this.checkpoints.get(id);
    if (!checkpoint) return false;
    this.checkpoints.delete(id);
    this.agentIndex.get(checkpoint.agentId)?.delete(id);
    return true;
  }

  async prune(agentId: string, keepCount: number): Promise<number> {
    const checkpoints = await this.list(agentId);
    const toDelete = checkpoints.slice(keepCount);
    for (const cp of toDelete) {
      await this.delete(cp.id);
    }
    return toDelete.length;
  }
}

export interface RollbackManagerOptions {
  maxCheckpoints: number;
  checkpointStore?: CheckpointStore;
}

export interface CheckpointDiff {
  configChanges: Array<{ key: string; before: unknown; after: unknown }>;
  toolsAdded: string[];
  toolsRemoved: string[];
  modificationsApplied: AppliedModification[];
}

export class RollbackManager {
  private maxCheckpoints: number;
  private store: CheckpointStore;

  constructor(options: RollbackManagerOptions) {
    this.maxCheckpoints = options.maxCheckpoints;
    this.store = options.checkpointStore ?? new InMemoryCheckpointStore();
  }

  async createCheckpoint(
    agentId: string,
    agentConfig: AgentConfig,
    tools: Tool[],
    modifications: AppliedModification[]
  ): Promise<ModificationCheckpoint> {
    const checkpoint: ModificationCheckpoint = {
      id: `ckpt_${nanoid(12)}`,
      agentId,
      timestamp: new Date(),
      agentConfig: { ...agentConfig },
      tools: tools.map((t) => ({ ...t })),
      modifications: [...modifications],
    };

    await this.store.save(checkpoint);
    await this.store.prune(agentId, this.maxCheckpoints);

    return checkpoint;
  }

  async getCheckpoint(id: string): Promise<ModificationCheckpoint | null> {
    return this.store.get(id);
  }

  async listCheckpoints(agentId: string): Promise<ModificationCheckpoint[]> {
    return this.store.list(agentId);
  }

  async getLatestCheckpoint(agentId: string): Promise<ModificationCheckpoint | null> {
    const checkpoints = await this.store.list(agentId);
    return checkpoints[0] ?? null;
  }

  async rollbackTo(
    checkpointId: string
  ): Promise<{ agentConfig: AgentConfig; tools: Tool[] } | null> {
    const checkpoint = await this.store.get(checkpointId);
    if (!checkpoint) return null;

    return {
      agentConfig: checkpoint.agentConfig as unknown as AgentConfig,
      tools: checkpoint.tools.map((t) => ({ ...t })),
    };
  }

  async rollbackToLatest(
    agentId: string
  ): Promise<{ agentConfig: AgentConfig; tools: Tool[] } | null> {
    const latest = await this.getLatestCheckpoint(agentId);
    if (!latest) return null;
    return this.rollbackTo(latest.id);
  }

  compareCheckpoints(
    checkpointA: ModificationCheckpoint,
    checkpointB: ModificationCheckpoint
  ): CheckpointDiff {
    const configChanges: CheckpointDiff['configChanges'] = [];
    const keysA = Object.keys(checkpointA.agentConfig) as (keyof AgentConfig)[];
    const keysB = Object.keys(checkpointB.agentConfig) as (keyof AgentConfig)[];
    const allKeys = new Set([...keysA, ...keysB]);

    for (const key of allKeys) {
      const valA = checkpointA.agentConfig[key];
      const valB = checkpointB.agentConfig[key];
      if (JSON.stringify(valA) !== JSON.stringify(valB)) {
        configChanges.push({ key, before: valA, after: valB });
      }
    }

    const toolsA = new Set(checkpointA.tools.map((t) => t.name));
    const toolsB = new Set(checkpointB.tools.map((t) => t.name));

    const toolsAdded = [...toolsB].filter((t) => !toolsA.has(t));
    const toolsRemoved = [...toolsA].filter((t) => !toolsB.has(t));

    const modsBefore = new Set(checkpointA.modifications.map((m) => m.id));
    const modificationsApplied = checkpointB.modifications.filter((m) => !modsBefore.has(m.id));

    return { configChanges, toolsAdded, toolsRemoved, modificationsApplied };
  }

  async pruneCheckpoints(agentId: string, keepCount?: number): Promise<number> {
    return this.store.prune(agentId, keepCount ?? this.maxCheckpoints);
  }

  async deleteCheckpoint(id: string): Promise<boolean> {
    return this.store.delete(id);
  }
}
