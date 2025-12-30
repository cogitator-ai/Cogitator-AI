/**
 * Filesystem tools - read, write, list, check, and delete files
 */

import { readFile, writeFile, readdir, stat, unlink, rm, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { tool } from '../tool';

const fileReadParams = z.object({
  path: z.string().describe('Path to the file to read'),
  encoding: z
    .enum(['utf-8', 'base64'])
    .optional()
    .describe('Encoding for the file content (default: utf-8)'),
});

export const fileRead = tool({
  name: 'file_read',
  description:
    'Read the contents of a file. Use base64 encoding for binary files.',
  parameters: fileReadParams,
  execute: async ({ path, encoding = 'utf-8' }) => {
    try {
      if (encoding === 'base64') {
        const buffer = await readFile(path);
        return { content: buffer.toString('base64'), path, encoding, size: buffer.length };
      }
      const content = await readFile(path, 'utf-8');
      return { content, path, encoding, size: content.length };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return { error: `File not found: ${path}`, path };
      }
      return { error: error.message, path };
    }
  },
});

const fileWriteParams = z.object({
  path: z.string().describe('Path to the file to write'),
  content: z.string().describe('Content to write to the file'),
  encoding: z
    .enum(['utf-8', 'base64'])
    .optional()
    .describe('Encoding of the content (default: utf-8). Use base64 for binary data.'),
  createDirs: z
    .boolean()
    .optional()
    .describe('Create parent directories if they do not exist (default: true)'),
});

export const fileWrite = tool({
  name: 'file_write',
  description:
    'Write content to a file. Creates parent directories if needed. Use base64 encoding for binary data.',
  parameters: fileWriteParams,
  sideEffects: ['filesystem'],
  execute: async ({ path, content, encoding = 'utf-8', createDirs = true }) => {
    try {
      if (createDirs) {
        await mkdir(dirname(path), { recursive: true });
      }

      if (encoding === 'base64') {
        const buffer = Buffer.from(content, 'base64');
        await writeFile(path, buffer);
        return { success: true, path, size: buffer.length };
      }

      await writeFile(path, content, 'utf-8');
      return { success: true, path, size: content.length };
    } catch (err) {
      return { error: (err as Error).message, path };
    }
  },
});

const fileListParams = z.object({
  path: z.string().describe('Directory path to list'),
  recursive: z.boolean().optional().describe('List files recursively (default: false)'),
  includeHidden: z.boolean().optional().describe('Include hidden files starting with . (default: false)'),
});

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
}

async function listDir(dirPath: string, recursive: boolean, includeHidden: boolean): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  const items = await readdir(dirPath, { withFileTypes: true });

  for (const item of items) {
    if (!includeHidden && item.name.startsWith('.')) {
      continue;
    }

    const fullPath = join(dirPath, item.name);
    const stats = await stat(fullPath);

    entries.push({
      name: item.name,
      path: fullPath,
      type: item.isDirectory() ? 'directory' : 'file',
      size: stats.size,
    });

    if (recursive && item.isDirectory()) {
      const subEntries = await listDir(fullPath, recursive, includeHidden);
      entries.push(...subEntries);
    }
  }

  return entries;
}

export const fileList = tool({
  name: 'file_list',
  description:
    'List contents of a directory. Returns files and subdirectories with their sizes.',
  parameters: fileListParams,
  execute: async ({ path, recursive = false, includeHidden = false }) => {
    try {
      const entries = await listDir(path, recursive, includeHidden);
      return {
        entries,
        count: entries.length,
        path,
        recursive,
      };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return { error: `Directory not found: ${path}`, path };
      }
      if (error.code === 'ENOTDIR') {
        return { error: `Not a directory: ${path}`, path };
      }
      return { error: error.message, path };
    }
  },
});

const fileExistsParams = z.object({
  path: z.string().describe('Path to check'),
});

export const fileExists = tool({
  name: 'file_exists',
  description: 'Check if a file or directory exists. Returns type (file/directory) if it exists.',
  parameters: fileExistsParams,
  execute: async ({ path }) => {
    try {
      const stats = await stat(path);
      return {
        exists: true,
        type: stats.isDirectory() ? 'directory' : 'file',
        size: stats.size,
        path,
      };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return { exists: false, path };
      }
      return { error: error.message, path };
    }
  },
});

const fileDeleteParams = z.object({
  path: z.string().describe('Path to the file or directory to delete'),
  recursive: z
    .boolean()
    .optional()
    .describe('For directories: delete contents recursively (default: false)'),
});

export const fileDelete = tool({
  name: 'file_delete',
  description:
    'Delete a file or directory. For directories, use recursive=true to delete non-empty directories.',
  parameters: fileDeleteParams,
  sideEffects: ['filesystem'],
  execute: async ({ path, recursive = false }) => {
    try {
      const stats = await stat(path);

      if (stats.isDirectory()) {
        await rm(path, { recursive });
      } else {
        await unlink(path);
      }

      return { success: true, path, type: stats.isDirectory() ? 'directory' : 'file' };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return { error: `Path not found: ${path}`, path };
      }
      if (error.code === 'ENOTEMPTY') {
        return { error: `Directory not empty. Use recursive=true to delete: ${path}`, path };
      }
      return { error: error.message, path };
    }
  },
});
