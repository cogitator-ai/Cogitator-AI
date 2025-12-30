/**
 * Tests for InMemoryMessageBus
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMessageBus } from '../communication/message-bus';

describe('InMemoryMessageBus', () => {
  let bus: InMemoryMessageBus;

  beforeEach(() => {
    bus = new InMemoryMessageBus({
      enabled: true,
      protocol: 'direct',
    });
  });

  describe('send', () => {
    it('should send a message and return it with id', async () => {
      const msg = await bus.send({
        swarmId: 'swarm1',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'Hello',
      });

      expect(msg.id).toBeDefined();
      expect(msg.from).toBe('agent1');
      expect(msg.to).toBe('agent2');
      expect(msg.content).toBe('Hello');
      expect(msg.timestamp).toBeGreaterThan(0);
    });

    it('should throw when disabled', async () => {
      const disabled = new InMemoryMessageBus({
        enabled: false,
        protocol: 'direct',
      });

      await expect(
        disabled.send({
          swarmId: 'swarm1',
          from: 'agent1',
          to: 'agent2',
          type: 'request',
          content: 'Hello',
        })
      ).rejects.toThrow('Message bus is not enabled');
    });
  });

  describe('getMessages', () => {
    it('should return messages for agent', async () => {
      await bus.send({
        swarmId: 'swarm1',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'Message 1',
      });

      await bus.send({
        swarmId: 'swarm1',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'Message 2',
      });

      const messages = bus.getMessages('agent2');
      expect(messages).toHaveLength(2);
    });

    it('should limit messages returned', async () => {
      for (let i = 0; i < 10; i++) {
        await bus.send({
          swarmId: 'swarm1',
          from: 'agent1',
          to: 'agent2',
          type: 'request',
          content: `Message ${i}`,
        });
      }

      const messages = bus.getMessages('agent2', 5);
      expect(messages).toHaveLength(5);
    });
  });

  describe('broadcast', () => {
    it('should create broadcast message', async () => {
      await bus.broadcast('agent1', 'Hello everyone', 'general');

      const all = bus.getAllMessages();
      expect(all).toHaveLength(1);
      expect(all[0].to).toBe('broadcast');
      expect(all[0].channel).toBe('general');
    });
  });

  describe('getConversation', () => {
    it('should return messages between two agents', async () => {
      await bus.send({
        swarmId: 'swarm1',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'Hi',
      });

      await bus.send({
        swarmId: 'swarm1',
        from: 'agent2',
        to: 'agent1',
        type: 'response',
        content: 'Hello',
      });

      await bus.send({
        swarmId: 'swarm1',
        from: 'agent3',
        to: 'agent2',
        type: 'request',
        content: 'Other',
      });

      const conversation = bus.getConversation('agent1', 'agent2');
      expect(conversation).toHaveLength(2);
    });
  });

  describe('subscribe', () => {
    it('should notify on new message', async () => {
      const received: string[] = [];

      bus.subscribe('agent2', (msg) => {
        received.push(msg.content);
      });

      await bus.send({
        swarmId: 'swarm1',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'Hello',
      });

      expect(received).toContain('Hello');
    });

    it('should allow unsubscription', async () => {
      const received: string[] = [];

      const unsub = bus.subscribe('agent2', (msg) => {
        received.push(msg.content);
      });

      await bus.send({
        swarmId: 'swarm1',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'First',
      });

      unsub();

      await bus.send({
        swarmId: 'swarm1',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'Second',
      });

      expect(received).toHaveLength(1);
    });
  });

  describe('clear', () => {
    it('should remove all messages', async () => {
      await bus.send({
        swarmId: 'swarm1',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'Hello',
      });

      bus.clear();

      expect(bus.getAllMessages()).toHaveLength(0);
    });
  });
});
