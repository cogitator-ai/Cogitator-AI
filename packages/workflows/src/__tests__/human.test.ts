import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  InMemoryApprovalStore,
  withDelegation,
  ConsoleNotifier,
  WebhookNotifier,
  CompositeNotifier,
  executeHumanNode,
  approvalNode,
  choiceNode,
  inputNode,
  ratingNode,
  chainNode,
  managementChain,
} from '../human/index';
import type { ApprovalRequest, ApprovalResponse, HumanNodeConfig } from '@cogitator-ai/types';

interface TestState {
  value: number;
  approved?: boolean;
}

describe('Human-in-the-Loop', () => {
  describe('InMemoryApprovalStore', () => {
    let store: InMemoryApprovalStore;

    beforeEach(() => {
      store = new InMemoryApprovalStore();
    });

    afterEach(() => {
      store.dispose();
    });

    it('creates and retrieves requests', async () => {
      const request: ApprovalRequest = {
        id: 'req-1',
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        type: 'approve-reject',
        title: 'Test Approval',
        description: 'Please approve',
        assignee: 'user@example.com',
        createdAt: Date.now(),
      };

      await store.createRequest(request);
      const retrieved = await store.getRequest('req-1');

      expect(retrieved).toEqual(request);
    });

    it('lists pending requests', async () => {
      await store.createRequest({
        id: 'req-1',
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        type: 'approve-reject',
        title: 'Pending',
        createdAt: Date.now(),
      });

      await store.createRequest({
        id: 'req-2',
        workflowId: 'wf-2',
        runId: 'run-2',
        nodeId: 'node-2',
        type: 'approve-reject',
        title: 'Also Pending',
        createdAt: Date.now(),
      });

      const pending = await store.getPendingRequests();
      expect(pending).toHaveLength(2);
    });

    it('filters pending by workflow', async () => {
      await store.createRequest({
        id: 'req-1',
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        type: 'approve-reject',
        title: 'WF1 Request',
        createdAt: Date.now(),
      });

      await store.createRequest({
        id: 'req-2',
        workflowId: 'wf-2',
        runId: 'run-2',
        nodeId: 'node-2',
        type: 'approve-reject',
        title: 'WF2 Request',
        createdAt: Date.now(),
      });

      const pending = await store.getPendingRequests('wf-1');
      expect(pending).toHaveLength(1);
      expect(pending[0].workflowId).toBe('wf-1');
    });

    it('gets pending for assignee', async () => {
      await store.createRequest({
        id: 'req-1',
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        type: 'approve-reject',
        title: 'Request',
        assignee: 'alice@example.com',
        createdAt: Date.now(),
      });

      await store.createRequest({
        id: 'req-2',
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-2',
        type: 'approve-reject',
        title: 'Request',
        assignee: 'bob@example.com',
        createdAt: Date.now(),
      });

      const alicePending = await store.getPendingForAssignee('alice@example.com');
      expect(alicePending).toHaveLength(1);
    });

    it('submits and retrieves responses', async () => {
      await store.createRequest({
        id: 'req-1',
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        type: 'approve-reject',
        title: 'Request',
        createdAt: Date.now(),
      });

      const response: ApprovalResponse = {
        requestId: 'req-1',
        decision: true,
        respondedBy: 'user@example.com',
        respondedAt: Date.now(),
        comment: 'Looks good!',
      };

      await store.submitResponse(response);

      const retrieved = await store.getResponse('req-1');
      expect(retrieved?.decision).toBe(true);
      expect(retrieved?.comment).toBe('Looks good!');

      const pending = await store.getPendingRequests();
      expect(pending).toHaveLength(0);
    });

    it('notifies on response', async () => {
      const callback = vi.fn();

      await store.createRequest({
        id: 'req-1',
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        type: 'approve-reject',
        title: 'Request',
        createdAt: Date.now(),
      });

      const unsubscribe = store.onResponse('req-1', callback);

      await store.submitResponse({
        requestId: 'req-1',
        decision: true,
        respondedBy: 'user',
        respondedAt: Date.now(),
      });

      expect(callback).toHaveBeenCalled();
      unsubscribe();
    });

    it('immediately notifies if response already exists', async () => {
      await store.createRequest({
        id: 'req-1',
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        type: 'approve-reject',
        title: 'Request',
        createdAt: Date.now(),
      });

      await store.submitResponse({
        requestId: 'req-1',
        decision: true,
        respondedBy: 'user',
        respondedAt: Date.now(),
      });

      const callback = vi.fn();
      store.onResponse('req-1', callback);

      await new Promise(resolve => queueMicrotask(resolve));

      expect(callback).toHaveBeenCalled();
    });

    it('deletes requests', async () => {
      await store.createRequest({
        id: 'req-1',
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        type: 'approve-reject',
        title: 'Request',
        createdAt: Date.now(),
      });

      await store.deleteRequest('req-1');

      const retrieved = await store.getRequest('req-1');
      expect(retrieved).toBeNull();
    });
  });

  describe('Delegation', () => {
    it('handles delegation', async () => {
      const baseStore = new InMemoryApprovalStore();
      const onDelegation = vi.fn();

      const store = withDelegation(baseStore, { onDelegation });

      await baseStore.createRequest({
        id: 'req-1',
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        type: 'approve-reject',
        title: 'Request',
        assignee: 'alice@example.com',
        createdAt: Date.now(),
      });

      await store.submitResponse({
        requestId: 'req-1',
        decision: null,
        respondedBy: 'alice@example.com',
        respondedAt: Date.now(),
        delegatedTo: 'bob@example.com',
        delegationReason: 'Out of office',
      });

      expect(onDelegation).toHaveBeenCalled();
      const [_request, from, to] = onDelegation.mock.calls[0];
      expect(from).toBe('alice@example.com');
      expect(to).toBe('bob@example.com');

      baseStore.dispose();
    });
  });

  describe('Notifiers', () => {
    it('ConsoleNotifier logs to console', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const notifier = new ConsoleNotifier();

      await notifier.notify({
        id: 'req-1',
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        type: 'approve-reject',
        title: 'Test Request',
        createdAt: Date.now(),
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('WebhookNotifier sends HTTP request', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      global.fetch = fetchMock;

      const notifier = new WebhookNotifier({ url: 'https://example.com/hook' });

      await notifier.notify({
        id: 'req-1',
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        type: 'approve-reject',
        title: 'Test Request',
        createdAt: Date.now(),
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('CompositeNotifier calls all notifiers', async () => {
      const notifier1 = { notify: vi.fn(), notifyTimeout: vi.fn(), notifyEscalation: vi.fn() };
      const notifier2 = { notify: vi.fn(), notifyTimeout: vi.fn(), notifyEscalation: vi.fn() };

      const composite = new CompositeNotifier([notifier1, notifier2]);

      await composite.notify({
        id: 'req-1',
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        type: 'approve-reject',
        title: 'Test',
        createdAt: Date.now(),
      });

      expect(notifier1.notify).toHaveBeenCalled();
      expect(notifier2.notify).toHaveBeenCalled();
    });
  });

  describe('Human Node Factories', () => {
    it('creates approval node', () => {
      const config = approvalNode<TestState>('review', {
        title: 'Review Changes',
        description: 'Please review the changes',
        assignee: 'reviewer@example.com',
        timeout: 3600000,
      });

      expect(config.name).toBe('review');
      expect(config.approval.type).toBe('approve-reject');
      expect(config.approval.title).toBe('Review Changes');
    });

    it('creates choice node', () => {
      const config = choiceNode<TestState>('select-option', {
        title: 'Select Action',
        choices: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
          { id: 'defer', label: 'Defer' },
        ],
      });

      expect(config.approval.type).toBe('multi-choice');
      expect(config.approval.choices).toHaveLength(3);
    });

    it('creates input node', () => {
      const config = inputNode<TestState>('get-reason', {
        title: 'Enter Reason',
        description: 'Please provide a reason',
      });

      expect(config.approval.type).toBe('free-form');
    });

    it('creates rating node', () => {
      const config = ratingNode<TestState>('rate-quality', {
        title: 'Rate Quality',
        description: 'Rate from 1 to 5',
      });

      expect(config.approval.type).toBe('numeric-rating');
    });

    it('creates chain node', () => {
      const config = chainNode<TestState>('approval-chain', {
        title: 'Multi-level Approval',
        chain: [
          { assignee: 'manager@example.com', role: 'Manager', required: true },
          { assignee: 'director@example.com', role: 'Director', required: true },
        ],
      });

      expect(config.approval.chain).toHaveLength(2);
    });

    it('creates management chain', () => {
      const config = managementChain<TestState>('budget-approval', {
        title: 'Budget Approval',
        manager: 'manager@example.com',
        director: 'director@example.com',
        vp: 'vp@example.com',
      });

      expect(config.approval.chain).toHaveLength(3);
      expect(config.approval.chain![0].role).toBe('Manager');
      expect(config.approval.chain![1].role).toBe('Director');
      expect(config.approval.chain![2].role).toBe('VP');
    });

    it('supports dynamic description', () => {
      const config = approvalNode<TestState>('dynamic', {
        title: 'Dynamic Review',
        description: (state) => `Review value: ${state.value}`,
      });

      const descFn = config.approval.description as (state: TestState) => string;
      expect(descFn({ value: 42 })).toBe('Review value: 42');
    });

    it('supports dynamic assignee', () => {
      const config = approvalNode<TestState>('dynamic-assignee', {
        title: 'Review',
        assignee: (state) => state.value > 100 ? 'senior@example.com' : 'junior@example.com',
      });

      const assigneeFn = config.approval.assignee as (state: TestState) => string;
      expect(assigneeFn({ value: 50 })).toBe('junior@example.com');
      expect(assigneeFn({ value: 150 })).toBe('senior@example.com');
    });
  });

  describe('executeHumanNode', () => {
    it('executes simple approval', async () => {
      const store = new InMemoryApprovalStore();

      const config: HumanNodeConfig<TestState> = {
        name: 'test-approval',
        approval: {
          type: 'approve-reject',
          title: 'Test Approval',
        },
      };

      const context = {
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        approvalStore: store,
      };

      const resultPromise = executeHumanNode({ value: 10 }, config, context);

      await new Promise(resolve => setTimeout(resolve, 10));

      const pending = await store.getPendingRequests();
      expect(pending).toHaveLength(1);

      await store.submitResponse({
        requestId: pending[0].id,
        decision: true,
        respondedBy: 'user',
        respondedAt: Date.now(),
      });

      const result = await resultPromise;

      expect(result.approved).toBe(true);
      expect(result.decision).toBe(true);

      store.dispose();
    });

    it('handles rejection', async () => {
      const store = new InMemoryApprovalStore();

      const config: HumanNodeConfig<TestState> = {
        name: 'test-rejection',
        approval: {
          type: 'approve-reject',
          title: 'Test',
        },
      };

      const context = {
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        approvalStore: store,
      };

      const resultPromise = executeHumanNode({ value: 10 }, config, context);

      await new Promise(resolve => setTimeout(resolve, 10));

      const pending = await store.getPendingRequests();
      await store.submitResponse({
        requestId: pending[0].id,
        decision: false,
        respondedBy: 'user',
        respondedAt: Date.now(),
      });

      const result = await resultPromise;

      expect(result.approved).toBe(false);

      store.dispose();
    });

    it('handles timeout with auto-approve', async () => {
      const store = new InMemoryApprovalStore();

      const config: HumanNodeConfig<TestState> = {
        name: 'test-timeout',
        approval: {
          type: 'approve-reject',
          title: 'Test',
          timeout: 50,
          timeoutAction: 'approve',
        },
      };

      const context = {
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        approvalStore: store,
      };

      const result = await executeHumanNode({ value: 10 }, config, context);

      expect(result.approved).toBe(true);
      expect(result.timedOut).toBe(true);

      store.dispose();
    });

    it('handles timeout with auto-reject', async () => {
      const store = new InMemoryApprovalStore();

      const config: HumanNodeConfig<TestState> = {
        name: 'test-timeout-reject',
        approval: {
          type: 'approve-reject',
          title: 'Test',
          timeout: 50,
          timeoutAction: 'reject',
        },
      };

      const context = {
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        approvalStore: store,
      };

      const result = await executeHumanNode({ value: 10 }, config, context);

      expect(result.approved).toBe(false);
      expect(result.timedOut).toBe(true);

      store.dispose();
    });

    it('handles multi-choice', async () => {
      const store = new InMemoryApprovalStore();

      const config: HumanNodeConfig<TestState> = {
        name: 'test-choice',
        approval: {
          type: 'multi-choice',
          title: 'Select',
          choices: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        },
      };

      const context = {
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        approvalStore: store,
      };

      const resultPromise = executeHumanNode({ value: 10 }, config, context);

      await new Promise(resolve => setTimeout(resolve, 10));

      const pending = await store.getPendingRequests();
      await store.submitResponse({
        requestId: pending[0].id,
        decision: 'b',
        respondedBy: 'user',
        respondedAt: Date.now(),
      });

      const result = await resultPromise;

      expect(result.approved).toBe(true);
      expect(result.decision).toBe('b');

      store.dispose();
    });

    it('handles free-form input', async () => {
      const store = new InMemoryApprovalStore();

      const config: HumanNodeConfig<TestState> = {
        name: 'test-freeform',
        approval: {
          type: 'free-form',
          title: 'Enter Text',
        },
      };

      const context = {
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        approvalStore: store,
      };

      const resultPromise = executeHumanNode({ value: 10 }, config, context);

      await new Promise(resolve => setTimeout(resolve, 10));

      const pending = await store.getPendingRequests();
      await store.submitResponse({
        requestId: pending[0].id,
        decision: 'This is my input',
        respondedBy: 'user',
        respondedAt: Date.now(),
      });

      const result = await resultPromise;

      expect(result.approved).toBe(true);
      expect(result.decision).toBe('This is my input');

      store.dispose();
    });

    it('handles numeric rating', async () => {
      const store = new InMemoryApprovalStore();

      const config: HumanNodeConfig<TestState> = {
        name: 'test-rating',
        approval: {
          type: 'numeric-rating',
          title: 'Rate',
        },
      };

      const context = {
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node-1',
        approvalStore: store,
      };

      const resultPromise = executeHumanNode({ value: 10 }, config, context);

      await new Promise(resolve => setTimeout(resolve, 10));

      const pending = await store.getPendingRequests();
      await store.submitResponse({
        requestId: pending[0].id,
        decision: 4,
        respondedBy: 'user',
        respondedAt: Date.now(),
      });

      const result = await resultPromise;

      expect(result.approved).toBe(true);
      expect(result.decision).toBe(4);

      store.dispose();
    });
  });
});
