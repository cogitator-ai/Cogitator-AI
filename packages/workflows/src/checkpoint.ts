/**
 * Checkpoint stores for workflow resume support
 */

import type { WorkflowCheckpoint, CheckpointStore } from '@cogitator/types';
import { nanoid } from 'nanoid';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * In-memory checkpoint store (for testing and short-lived workflows)
 */
export class InMemoryCheckpointStore implements CheckpointStore {
  private checkpoints = new Map<string, WorkflowCheckpoint>();

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.id, { ...checkpoint });
  }

  async load(id: string): Promise<WorkflowCheckpoint | null> {
    const checkpoint = this.checkpoints.get(id);
    return checkpoint ? { ...checkpoint } : null;
  }

  async list(workflowName: string): Promise<WorkflowCheckpoint[]> {
    const result: WorkflowCheckpoint[] = [];
    for (const checkpoint of this.checkpoints.values()) {
      if (checkpoint.workflowName === workflowName) {
        result.push({ ...checkpoint });
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
    try {
      await fs.mkdir(this.directory, { recursive: true });
    } catch {
      // Directory already exists
    }
  }

  private getFilePath(id: string): string {
    return path.join(this.directory, `${id}.json`);
  }

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    await this.ensureDirectory();
    const filePath = this.getFilePath(checkpoint.id);
    await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');
  }

  async load(id: string): Promise<WorkflowCheckpoint | null> {
    try {
      const filePath = this.getFilePath(id);
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as WorkflowCheckpoint;
    } catch {
      return null;
    }
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
        } catch {
          // Skip invalid files
        }
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
    } catch {
      // File doesn't exist
    }
  }
}

/**
 * Create a new checkpoint ID
 */
export function createCheckpointId(): string {
  return `ckpt_${nanoid(12)}`;
}
