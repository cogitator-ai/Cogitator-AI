# @cogitator-ai/rag

## 0.1.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/memory@0.6.17

## 0.1.5

### Patch Changes

- @cogitator-ai/memory@0.6.16

## 0.1.4

### Patch Changes

- fix(rag): audit — 21 bugs fixed, +13 regression tests
  - Fixed infinite loop when chunkOverlap >= chunkSize (FixedSizeChunker, RecursiveChunker)
  - Fixed PDFLoader.splitPages producing empty content
  - Fixed CohereReranker out-of-bounds index + empty results handling
  - Fixed LLMReranker greedy regex, unclamped scores, empty results
  - Fixed pipeline vectors/chunks mismatch validation, empty chunks guard
  - Fixed unsafe casts in retrievers (documentId), JSONLoader (primitives)
  - Removed dead MultiQueryRetriever.defaultQueryCount config
  - Aligned SimilarityRetriever default threshold to 0.0 (matching schema)
  - Removed unused @cogitator-ai/core peer dependency
  - Fixed README inaccuracies (CSVLoader options, JSONLoader description)

## 0.1.3

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.1.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/memory@0.6.14
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2
