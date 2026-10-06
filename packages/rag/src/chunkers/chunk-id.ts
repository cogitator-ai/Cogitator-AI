/** The id of a chunk: its document and its position, so re-chunking a document gives the same ids. */
export function chunkId(documentId: string, order: number): string {
  return `${documentId}:${order}`;
}
