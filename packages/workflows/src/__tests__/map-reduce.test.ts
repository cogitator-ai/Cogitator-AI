import { describe, it, expect, vi } from 'vitest';
import {
  executeMap,
  executeReduce,
  executeMapReduce,
  parallelMap,
  sequentialMap,
  batchedMap,
  collect,
  sum,
  count,
  first,
  last,
  groupBy,
  partition,
  flatMap,
  stats,
  mapNode,
  reduceNode,
  mapReduceNode,
  type MapItemResult,
} from '../patterns/index';

interface TestState {
  items: number[];
  multiplier?: number;
}

interface _ObjectState {
  items: { value: number }[];
}

interface TypedItemState {
  items: { type: string; value: number }[];
}

describe('Map-Reduce Pattern', () => {
  describe('executeMap', () => {
    it('maps items in parallel by default', async () => {
      const state: TestState = { items: [1, 2, 3, 4, 5] };
      const mapper = vi.fn(async (item: unknown) => (item as number) * 2);

      const results = await executeMap(state, {
        name: 'test-map',
        items: (s) => s.items,
        mapper,
      });

      expect(results).toHaveLength(5);
      expect(results.every((r) => r.success)).toBe(true);
      expect(results.map((r) => r.result)).toEqual([2, 4, 6, 8, 10]);
      expect(mapper).toHaveBeenCalledTimes(5);
    });

    it('respects concurrency limit', async () => {
      const state: TestState = { items: [1, 2, 3, 4, 5] };
      let concurrent = 0;
      let maxConcurrent = 0;

      const results = await executeMap(state, {
        name: 'concurrency-test',
        items: (s) => s.items,
        mapper: async (item: unknown) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 10));
          concurrent--;
          return (item as number) * 2;
        },
        concurrency: 2,
      });

      expect(results).toHaveLength(5);
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('handles errors with continueOnError', async () => {
      const state: TestState = { items: [1, 2, 3, 4, 5] };

      const results = await executeMap(state, {
        name: 'error-test',
        items: (s) => s.items,
        mapper: async (item: unknown) => {
          if (item === 3) throw new Error('skip 3');
          return (item as number) * 2;
        },
        continueOnError: true,
      });

      expect(results).toHaveLength(5);
      expect(results.filter((r) => r.success)).toHaveLength(4);
      expect(results.find((r) => !r.success)?.item).toBe(3);
    });

    it('stops on first error by default', async () => {
      const state: TestState = { items: [1, 2, 3, 4, 5] };
      const mapper = vi.fn(async (item: unknown) => {
        if (item === 3) throw new Error('stop at 3');
        return (item as number) * 2;
      });

      await expect(
        executeMap(state, {
          name: 'stop-on-error',
          items: (s) => s.items,
          mapper,
        })
      ).rejects.toThrow('stop at 3');
    });

    it('calls onProgress callback', async () => {
      const state: TestState = { items: [1, 2, 3] };
      const onProgress = vi.fn();

      await executeMap(state, {
        name: 'progress-test',
        items: (s) => s.items,
        mapper: async (item: unknown) => (item as number) * 2,
        onProgress,
      });

      expect(onProgress).toHaveBeenCalled();
      const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1][0];
      expect(lastCall.completed).toBe(3);
      expect(lastCall.total).toBe(3);
    });

    it('supports filter option', async () => {
      const state: TestState = { items: [1, 2, 3, 4, 5] };

      const results = await executeMap(state, {
        name: 'filter-test',
        items: (s) => s.items,
        mapper: async (item: unknown) => (item as number) * 2,
        filter: (item) => (item as number) % 2 === 0,
      });

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.result)).toEqual([4, 8]);
    });

    it('supports transform option', async () => {
      const state: TestState = { items: [1, 2, 3], multiplier: 10 };

      const results = await executeMap(state, {
        name: 'transform-test',
        items: (s) => s.items,
        mapper: async (item: unknown) => item as number,
        transform: (item, _idx, s) => (item as number) * (s.multiplier ?? 1),
      });

      expect(results.map((r) => r.result)).toEqual([10, 20, 30]);
    });
  });

  describe('executeReduce', () => {
    it('reduces map results', () => {
      const mapResults: MapItemResult<number>[] = [
        { index: 0, item: 1, result: 1, success: true, duration: 10 },
        { index: 1, item: 2, result: 2, success: true, duration: 10 },
        { index: 2, item: 3, result: 3, success: true, duration: 10 },
        { index: 3, item: 4, result: 4, success: true, duration: 10 },
        { index: 4, item: 5, result: 5, success: true, duration: 10 },
      ];

      const state: TestState = { items: [] };
      const result = executeReduce(mapResults, state, {
        name: 'sum-reduce',
        initial: 0,
        reducer: (acc, item) => acc + item.result,
      });

      expect(result).toBe(15);
    });

    it('filters failed results by default', () => {
      const mapResults: MapItemResult<number>[] = [
        { index: 0, item: 1, result: 1, success: true, duration: 10 },
        { index: 1, item: 2, result: 2, success: false, error: new Error('fail'), duration: 10 },
        { index: 2, item: 3, result: 3, success: true, duration: 10 },
      ];

      const state: TestState = { items: [] };
      const result = executeReduce(mapResults, state, {
        name: 'filter-failed',
        initial: 0,
        reducer: (acc, item) => acc + item.result,
      });

      expect(result).toBe(4);
    });

    it('includes failed results when successOnly is false', () => {
      const mapResults: MapItemResult<number>[] = [
        { index: 0, item: 1, result: 1, success: true, duration: 10 },
        { index: 1, item: 2, result: 0, success: false, error: new Error('fail'), duration: 10 },
        { index: 2, item: 3, result: 3, success: true, duration: 10 },
      ];

      const state: TestState = { items: [] };
      const result = executeReduce(mapResults, state, {
        name: 'include-failed',
        initial: 0,
        reducer: (acc, item) => acc + item.result,
        successOnly: false,
      });

      expect(result).toBe(4);
    });

    it('supports finalize option', () => {
      const mapResults: MapItemResult<number>[] = [
        { index: 0, item: 1, result: 2, success: true, duration: 10 },
        { index: 1, item: 2, result: 4, success: true, duration: 10 },
      ];

      const state: TestState = { items: [] };
      const result = executeReduce(mapResults, state, {
        name: 'finalize-test',
        initial: 0,
        reducer: (acc, item) => acc + item.result,
        finalize: (sum) => sum * 2,
      });

      expect(result).toBe(12);
    });
  });

  describe('executeMapReduce', () => {
    it('combines map and reduce', async () => {
      const state: TestState = { items: [1, 2, 3, 4, 5] };

      const result = await executeMapReduce(state, {
        name: 'map-reduce-test',
        map: {
          items: (s) => s.items,
          mapper: async (item: unknown) => (item as number) * 2,
        },
        reduce: {
          initial: 0,
          reducer: (acc, item) => acc + item.result,
        },
      });

      expect(result.reduced).toBe(30);
      expect(result.results).toHaveLength(5);
      expect(result.stats.successful).toBe(5);
    });

    it('handles partial failures', async () => {
      const state: TestState = { items: [1, 2, 3, 4, 5] };

      const result = await executeMapReduce(state, {
        name: 'partial-failure',
        map: {
          items: (s) => s.items,
          mapper: async (item: unknown) => {
            if (item === 3) throw new Error('skip');
            return (item as number) * 2;
          },
          continueOnError: true,
        },
        reduce: {
          initial: 0,
          reducer: (acc, item) => acc + item.result,
        },
      });

      expect(result.reduced).toBe(24);
      expect(result.stats.failed).toBe(1);
    });

    it('supports streaming reduce', async () => {
      const state: TestState = { items: [1, 2, 3] };
      const reducedValues: number[] = [];

      const result = await executeMapReduce(state, {
        name: 'streaming-reduce',
        map: {
          items: (s) => s.items,
          mapper: async (item: unknown) => (item as number) * 2,
          concurrency: 1,
        },
        reduce: {
          initial: 0,
          reducer: (acc, item) => {
            const newAcc = acc + item.result;
            reducedValues.push(newAcc);
            return newAcc;
          },
          streaming: true,
        },
      });

      expect(result.reduced).toBe(12);
    });
  });

  describe('Mapper Helpers', () => {
    describe('parallelMap', () => {
      it('maps all items in parallel', async () => {
        const state: TestState = { items: [1, 2, 3] };
        const results = await parallelMap(
          state,
          (s) => s.items,
          async (x) => (x as number) * 2
        );
        expect(results.map((r) => r.result)).toEqual([2, 4, 6]);
      });
    });

    describe('sequentialMap', () => {
      it('maps items one by one', async () => {
        const order: number[] = [];
        const state: TestState = { items: [1, 2, 3] };

        const results = await sequentialMap(
          state,
          (s) => s.items,
          async (x) => {
            const num = x as number;
            order.push(num);
            await new Promise((resolve) => setTimeout(resolve, 10));
            return num * 2;
          }
        );

        expect(results.map((r) => r.result)).toEqual([2, 4, 6]);
        expect(order).toEqual([1, 2, 3]);
      });
    });

    describe('batchedMap', () => {
      it('processes items with limited concurrency', async () => {
        const state: TestState = { items: [1, 2, 3, 4, 5, 6] };
        let maxConcurrent = 0;
        let concurrent = 0;

        const results = await batchedMap(
          state,
          (s) => s.items,
          async (item) => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await new Promise((resolve) => setTimeout(resolve, 10));
            concurrent--;
            return (item as number) * 2;
          },
          2
        );

        expect(results.map((r) => r.result)).toEqual([2, 4, 6, 8, 10, 12]);
        expect(maxConcurrent).toBeLessThanOrEqual(2);
      });
    });
  });

  describe('Reducer Helpers', () => {
    const createMapResults = <T>(items: T[]): MapItemResult<T>[] =>
      items.map((item, index) => ({
        index,
        item,
        result: item,
        success: true,
        duration: 10,
      }));

    describe('collect', () => {
      it('collects all results into array', () => {
        const mapResults = createMapResults([1, 2, 3]);
        const state: TestState = { items: [] };
        const config = collect<number>();
        const result = executeReduce(mapResults, state, { name: 'collect', ...config });
        expect(result).toEqual([1, 2, 3]);
      });
    });

    describe('sum', () => {
      it('sums numeric results', () => {
        const mapResults = createMapResults([1, 2, 3, 4, 5]);
        const state: TestState = { items: [] };
        const config = sum();
        const result = executeReduce(mapResults, state, { name: 'sum', ...config });
        expect(result).toBe(15);
      });
    });

    describe('count', () => {
      it('counts items', () => {
        const mapResults = createMapResults([1, 2, 3, 4, 5]);
        const state: TestState = { items: [] };
        const config = count();
        const result = executeReduce(mapResults, state, { name: 'count', ...config });
        expect(result).toBe(5);
      });
    });

    describe('first', () => {
      it('returns first result', () => {
        const mapResults = createMapResults([1, 2, 3]);
        const state: TestState = { items: [] };
        const config = first<number>();
        const result = executeReduce(mapResults, state, { name: 'first', ...config });
        expect(result).toBe(1);
      });

      it('returns undefined for empty array', () => {
        const mapResults: MapItemResult<number>[] = [];
        const state: TestState = { items: [] };
        const config = first<number>();
        const result = executeReduce(mapResults, state, { name: 'first', ...config });
        expect(result).toBeUndefined();
      });
    });

    describe('last', () => {
      it('returns last result', () => {
        const mapResults = createMapResults([1, 2, 3]);
        const state: TestState = { items: [] };
        const config = last<number>();
        const result = executeReduce(mapResults, state, { name: 'last', ...config });
        expect(result).toBe(3);
      });
    });

    describe('groupBy', () => {
      it('groups results by key', () => {
        const items = [
          { type: 'a', value: 1 },
          { type: 'b', value: 2 },
          { type: 'a', value: 3 },
        ];
        const mapResults = createMapResults(items);
        const state: TypedItemState = { items: [] };
        const config = groupBy<{ type: string; value: number }, string>((result) => result.type);
        const result = executeReduce(mapResults, state, { name: 'groupBy', ...config });

        expect(result.a).toHaveLength(2);
        expect(result.b).toHaveLength(1);
      });
    });

    describe('partition', () => {
      it('partitions results by predicate', () => {
        const mapResults = createMapResults([1, 2, 3, 4, 5]);
        const state: TestState = { items: [] };
        const config = partition<number>((x) => x % 2 === 0);
        const result = executeReduce(mapResults, state, { name: 'partition', ...config });

        expect(result.pass).toEqual([2, 4]);
        expect(result.fail).toEqual([1, 3, 5]);
      });
    });

    describe('flatMap', () => {
      it('flattens array results', () => {
        const mapResults: MapItemResult<number[]>[] = [
          { index: 0, item: 1, result: [1, 10], success: true, duration: 10 },
          { index: 1, item: 2, result: [2, 20], success: true, duration: 10 },
          { index: 2, item: 3, result: [3, 30], success: true, duration: 10 },
        ];
        const state: TestState = { items: [] };
        const config = flatMap<number>();
        const result = executeReduce(mapResults, state, { name: 'flatMap', ...config });
        expect(result).toEqual([1, 10, 2, 20, 3, 30]);
      });
    });

    describe('stats', () => {
      it('calculates statistics', () => {
        const mapResults = createMapResults([1, 2, 3, 4, 5]);
        const state: TestState = { items: [] };
        const config = stats();
        const result = executeReduce(mapResults, state, { name: 'stats', ...config });

        expect(result.count).toBe(5);
        expect(result.sum).toBe(15);
        expect(result.min).toBe(1);
        expect(result.max).toBe(5);
        expect(result.avg).toBe(3);
      });

      it('handles empty array', () => {
        const mapResults: MapItemResult<number>[] = [];
        const state: TestState = { items: [] };
        const config = stats();
        const result = executeReduce(mapResults, state, { name: 'stats', ...config });

        expect(result.count).toBe(0);
        expect(result.sum).toBe(0);
        expect(result.avg).toBe(0);
        expect(result.min).toBe(0);
        expect(result.max).toBe(0);
      });
    });
  });

  describe('Node Factories', () => {
    it('creates map node config', () => {
      const config = mapNode<TestState, number>('test-map', {
        items: (s) => s.items,
        mapper: async (x) => (x as number) * 2,
      });

      expect(config.name).toBe('test-map');
      expect(config.items).toBeDefined();
      expect(config.mapper).toBeDefined();
    });

    it('creates reduce node config', () => {
      const config = reduceNode<TestState, number, number>('test-reduce', {
        initial: 0,
        reducer: (acc, item) => acc + item.result,
      });

      expect(config.name).toBe('test-reduce');
      expect(config.initial).toBe(0);
      expect(config.reducer).toBeDefined();
    });

    it('creates map-reduce node config', () => {
      const config = mapReduceNode<TestState, number, number>('test-mr', {
        map: {
          items: (s) => s.items,
          mapper: async (x) => (x as number) * 2,
        },
        reduce: {
          initial: 0,
          reducer: (acc, item) => acc + item.result,
        },
      });

      expect(config.name).toBe('test-mr');
      expect(config.map.items).toBeDefined();
      expect(config.reduce.initial).toBe(0);
    });
  });
});
