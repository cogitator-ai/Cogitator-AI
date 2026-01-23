import { tokenize, getTermFrequency, type TokenizerConfig } from './tokenizer';

export interface BM25Config {
  k1?: number;
  b?: number;
  tokenizer?: TokenizerConfig;
}

export interface BM25Document {
  id: string;
  content: string;
}

interface IndexedDocument {
  id: string;
  content: string;
  tokens: string[];
  termFreq: Map<string, number>;
  length: number;
}

export interface BM25Result {
  id: string;
  content: string;
  score: number;
}

export class BM25Index {
  private documents = new Map<string, IndexedDocument>();
  private invertedIndex = new Map<string, Set<string>>();
  private avgDocLength = 0;
  private k1: number;
  private b: number;
  private tokenizerConfig: TokenizerConfig;

  constructor(config: BM25Config = {}) {
    this.k1 = config.k1 ?? 1.5;
    this.b = config.b ?? 0.75;
    this.tokenizerConfig = config.tokenizer ?? {};
  }

  get size(): number {
    return this.documents.size;
  }

  addDocument(doc: BM25Document): void {
    if (this.documents.has(doc.id)) {
      this.removeDocument(doc.id);
    }

    const tokens = tokenize(doc.content, this.tokenizerConfig);
    const termFreq = getTermFrequency(tokens);

    const indexed: IndexedDocument = {
      id: doc.id,
      content: doc.content,
      tokens,
      termFreq,
      length: tokens.length,
    };

    this.documents.set(doc.id, indexed);

    for (const term of termFreq.keys()) {
      const docSet = this.invertedIndex.get(term) ?? new Set();
      docSet.add(doc.id);
      this.invertedIndex.set(term, docSet);
    }

    this.updateAvgDocLength();
  }

  addDocuments(docs: BM25Document[]): void {
    for (const doc of docs) {
      this.addDocument(doc);
    }
  }

  removeDocument(id: string): boolean {
    const doc = this.documents.get(id);
    if (!doc) return false;

    for (const term of doc.termFreq.keys()) {
      const docSet = this.invertedIndex.get(term);
      if (docSet) {
        docSet.delete(id);
        if (docSet.size === 0) {
          this.invertedIndex.delete(term);
        }
      }
    }

    this.documents.delete(id);
    this.updateAvgDocLength();
    return true;
  }

  search(query: string, limit = 10): BM25Result[] {
    if (this.documents.size === 0) return [];

    const queryTerms = tokenize(query, this.tokenizerConfig);
    if (queryTerms.length === 0) return [];

    const scores: BM25Result[] = [];
    const N = this.documents.size;

    for (const [id, doc] of this.documents) {
      const score = this.calculateScore(queryTerms, doc, N);
      if (score > 0) {
        scores.push({ id, content: doc.content, score });
      }
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  getDocument(id: string): BM25Document | undefined {
    const doc = this.documents.get(id);
    if (!doc) return undefined;
    return { id: doc.id, content: doc.content };
  }

  clear(): void {
    this.documents.clear();
    this.invertedIndex.clear();
    this.avgDocLength = 0;
  }

  private calculateScore(queryTerms: string[], doc: IndexedDocument, N: number): number {
    let score = 0;

    for (const term of queryTerms) {
      const df = this.invertedIndex.get(term)?.size ?? 0;
      if (df === 0) continue;

      const tf = doc.termFreq.get(term) ?? 0;
      if (tf === 0) continue;

      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      const tfNormalized =
        (tf * (this.k1 + 1)) /
        (tf + this.k1 * (1 - this.b + this.b * (doc.length / this.avgDocLength)));

      score += idf * tfNormalized;
    }

    return score;
  }

  private updateAvgDocLength(): void {
    if (this.documents.size === 0) {
      this.avgDocLength = 0;
      return;
    }

    let totalLength = 0;
    for (const doc of this.documents.values()) {
      totalLength += doc.length;
    }
    this.avgDocLength = totalLength / this.documents.size;
  }
}
