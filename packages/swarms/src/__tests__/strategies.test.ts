/**
 * Tests for strategy factory
 */

import { describe, it, expect } from 'vitest';
import { getDefaultStrategyConfig } from '../strategies/index';

describe('Strategy Factory', () => {
  describe('getDefaultStrategyConfig', () => {
    it('should return hierarchical defaults', () => {
      const config = getDefaultStrategyConfig('hierarchical');
      expect(config.hierarchical).toBeDefined();
      expect(config.hierarchical!.maxDelegationDepth).toBe(3);
      expect(config.hierarchical!.workerCommunication).toBe(false);
    });

    it('should return round-robin defaults', () => {
      const config = getDefaultStrategyConfig('round-robin');
      expect(config.roundRobin).toBeDefined();
      expect(config.roundRobin!.sticky).toBe(false);
      expect(config.roundRobin!.rotation).toBe('sequential');
    });

    it('should return consensus defaults', () => {
      const config = getDefaultStrategyConfig('consensus');
      expect(config.consensus).toBeDefined();
      expect(config.consensus!.threshold).toBe(0.5);
      expect(config.consensus!.maxRounds).toBe(3);
      expect(config.consensus!.resolution).toBe('majority');
    });

    it('should return auction defaults', () => {
      const config = getDefaultStrategyConfig('auction');
      expect(config.auction).toBeDefined();
      expect(config.auction!.bidding).toBe('capability-match');
      expect(config.auction!.selection).toBe('highest-bid');
    });

    it('should return pipeline defaults', () => {
      const config = getDefaultStrategyConfig('pipeline');
      expect(config.pipeline).toBeDefined();
      expect(config.pipeline!.stages).toEqual([]);
    });

    it('should return debate defaults', () => {
      const config = getDefaultStrategyConfig('debate');
      expect(config.debate).toBeDefined();
      expect(config.debate!.rounds).toBe(3);
      expect(config.debate!.format).toBe('structured');
    });
  });
});
