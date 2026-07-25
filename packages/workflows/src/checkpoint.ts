/**
 * Checkpoint stores for workflow resume support
 */

import type { WorkflowCheckpoint, CheckpointStore } from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * In-memory checkpoint store (for testing and short-lived workflows)
 */
export class InMemoryCheckpointStore implements CheckpointStore {
  private checkpoints = new Map<string, WorkflowCheckpoint>();

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.id, structuredClone(checkpoint));
  }

  async load(id: string): Promise<WorkflowCheckpoint | null> {
    const checkpoint = this.checkpoints.get(id);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async list(workflowName: string): Promise<WorkflowCheckpoint[]> {
    const result: WorkflowCheckpoint[] = [];
    for (const checkpoint of this.checkpoints.values()) {
      if (checkpoint.workflowName === workflowName) {
        result.push(structuredClone(checkpoint));
      }
    }
    return result.sort((a, b) => b.timestamp - a.timestamp);
  }

  async delete(id: string): Promise<void> {
    this.checkpoints.delete(id);
  }

  clear(): void {
    this.checkpoints.clear();
  }
}

/**
 * File-based checkpoint store (persists to disk)
 */
export class FileCheckpointStore implements CheckpointStore {
  private directory: string;

  constructor(directory?: string) {
    this.directory = directory ?? '.cogitator/checkpoints';
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
  }

  private getFilePath(id: string): string {
    const sanitized = path.basename(id);
    return path.join(this.directory, `${sanitized}.json`);
  }

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    await this.ensureDirectory();
    const filePath = this.getFilePath(checkpoint.id);
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  async load(id: string): Promise<WorkflowCheckpoint | null> {
    const filePath = this.getFilePath(id);

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (e: unknown) {
      if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw e;
    }

    return JSON.parse(content) as WorkflowCheckpoint;
  }

  async list(workflowName: string): Promise<WorkflowCheckpoint[]> {
    await this.ensureDirectory();

    try {
      const files = await fs.readdir(this.directory);
      const checkpoints: WorkflowCheckpoint[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(this.directory, file);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const checkpoint = JSON.parse(content) as WorkflowCheckpoint;
          if (checkpoint.workflowName === workflowName) {
            checkpoints.push(checkpoint);
          }
        } catch {}
      }

      return checkpoints.sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const filePath = this.getFilePath(id);
      await fs.unlink(filePath);
    } catch {}
  }
}

/**
 * Create a new checkpoint ID
 */
export function createCheckpointId(): string {
  return `ckpt_${nanoid(12)}`;
}
