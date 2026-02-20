import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import {
  WorkflowBuilder,
  WorkflowExecutor,
  agentNode,
  functionNode,
  InMemoryApprovalStore,
  ConsoleNotifier,
  executeHumanNode,
  approvalNode,
  choiceNode,
  inputNode,
} from '@cogitator-ai/workflows';
import type { HumanNodeConfig } from '@cogitator-ai/workflows';

interface PublishingState {
  [key: string]: unknown;
  topic: string;
  draft: string;
  editorialDecision: string;
  editorNotes: string;
  publishChannel: string;
  finalContent: string;
  status: string;
}

async function main() {
  header('02 — Human-in-the-Loop: Content Publishing Workflow');
  const cog = createCogitator();

  const approvalStore = new InMemoryApprovalStore();
  const notifier = new ConsoleNotifier();

  section('1. Defining human interaction nodes');

  const editorialApproval = approvalNode<PublishingState>('editorial-review', {
    title: 'Editorial Review',
    description: (state) =>
      `Review the following draft about "${state.topic}":\n\n${state.draft.slice(0, 200)}...`,
    assignee: 'editor@company.com',
    timeout: 5_000,
    timeoutAction: 'approve',
    priority: 'high',
  });

  const channelChoice = choiceNode<PublishingState>('channel-selection', {
    title: 'Select Publishing Channel',
    description: 'Choose where to publish this content',
    choices: [
      { id: 'blog', label: 'Company Blog', value: 'blog', description: 'Main engineering blog' },
      {
        id: 'newsletter',
        label: 'Newsletter',
        value: 'newsletter',
        description: 'Weekly email digest',
      },
      {
        id: 'social',
        label: 'Social Media',
        value: 'social',
        description: 'Twitter/LinkedIn post',
      },
    ],
    assignee: 'marketing@company.com',
    timeout: 5_000,
  });

  const editorFeedback = inputNode<PublishingState>('editor-notes', {
    title: 'Editor Notes',
    description: (state) =>
      `Add any notes or revision requests for the draft about "${state.topic}"`,
    assignee: 'editor@company.com',
    timeout: 5_000,
  });

  console.log(
    `  Editorial approval: ${editorialApproval.name} (${editorialApproval.approval.type})`
  );
  console.log(`  Channel choice:     ${channelChoice.name} (${channelChoice.approval.type})`);
  console.log(`  Editor feedback:    ${editorFeedback.name} (${editorFeedback.approval.type})`);

  section('2. Building the workflow');

  const writer = new Agent({
    name: 'content-writer',
    model: DEFAULT_MODEL,
    instructions: `You are a technical content writer. Write engaging, concise content.
Keep drafts under 200 words. Use clear language, avoid jargon.
Format with a title, intro paragraph, and 2-3 key points.`,
    temperature: 0.7,
    maxIterations: 3,
  });

  const writerNode = agentNode<PublishingState>(writer, {
    inputMapper: (state) => `Write a short blog post about: ${state.topic}`,
    stateMapper: (result) => ({ draft: result.output }),
  });

  const simulateHumanApproval = (
    config: HumanNodeConfig<PublishingState>,
    respondWith: unknown,
    delay = 100
  ) =>
    functionNode<PublishingState, unknown>(config.name, async (state) => {
      const context = {
        workflowId: 'wf-demo',
        runId: 'run-demo',
        nodeId: config.name,
        approvalStore,
        approvalNotifier: notifier,
      };

      const resultPromise = executeHumanNode(state, config, context);

      setTimeout(async () => {
        const pending = await approvalStore.getPendingRequests();
        const request = pending.find((r) => r.nodeId === config.name);
        if (request) {
          await approvalStore.submitResponse({
            requestId: request.id,
            decision: respondWith,
            respondedBy: (config.approval.assignee as string) ?? 'demo-user',
            respondedAt: Date.now(),
            comment: 'Auto-responded for demo',
          });
        }
      }, delay);

      const result = await resultPromise;
      return result;
    });

  const approvalNodeFn = simulateHumanApproval(editorialApproval, true);
  const feedbackNodeFn = simulateHumanApproval(
    editorFeedback,
    'Great draft! Consider adding a code example.'
  );
  const channelNodeFn = simulateHumanApproval(channelChoice, 'blog');

  const formatForChannel = functionNode<PublishingState, string>(
    'format-content',
    async (state) => {
      const channel = state.publishChannel || 'blog';
      switch (channel) {
        case 'social':
          return `[Social] ${state.draft.slice(0, 280)}`;
        case 'newsletter':
          return `--- Newsletter Edition ---\n\n${state.draft}\n\n---\nSubscribe for more!`;
        default:
          return state.draft;
      }
    },
    {
      stateMapper: (output) => ({
        finalContent: output as string,
        status: 'published',
      }),
    }
  );

  const workflow = new WorkflowBuilder<PublishingState>('content-publishing')
    .initialState({
      topic: '',
      draft: '',
      editorialDecision: '',
      editorNotes: '',
      publishChannel: 'blog',
      finalContent: '',
      status: 'draft',
    })
    .addNode(writerNode.name, writerNode.fn)
    .addNode(approvalNodeFn.name, approvalNodeFn.fn, { after: [writerNode.name] })
    .addNode(feedbackNodeFn.name, feedbackNodeFn.fn, { after: [approvalNodeFn.name] })
    .addNode(channelNodeFn.name, channelNodeFn.fn, { after: [feedbackNodeFn.name] })
    .addNode(formatForChannel.name, formatForChannel.fn, { after: [channelNodeFn.name] })
    .entryPoint(writerNode.name)
    .build();

  console.log(`  Workflow: ${workflow.name}`);
  console.log(`  Nodes:   ${workflow.nodes.size}`);
  console.log(`  Entry:   ${workflow.entryPoint}`);

  section('3. Executing with simulated human responses');

  const executor = new WorkflowExecutor(cog);
  const result = await executor.execute(
    workflow,
    { topic: 'Building type-safe AI agents with TypeScript' },
    {
      onNodeStart: (node) => console.log(`  [start] ${node}`),
      onNodeComplete: (node, _output, duration) => console.log(`  [done]  ${node} (${duration}ms)`),
    }
  );

  section('4. Results');

  console.log(`  Status:   ${result.state.status}`);
  console.log(`  Duration: ${result.duration}ms`);
  if (result.error) {
    console.log(`  Error:    ${result.error.message}`);
  }

  section('5. Draft content');

  const draftLines = result.state.draft.split('\n').slice(0, 10);
  for (const line of draftLines) {
    console.log(`  ${line}`);
  }
  if (result.state.draft.split('\n').length > 10) {
    console.log(`  ... (truncated)`);
  }

  section('6. Human node configs (for reference)');

  const configs = [editorialApproval, channelChoice, editorFeedback];
  for (const config of configs) {
    console.log(`  ${config.name}:`);
    console.log(`    Type:     ${config.approval.type}`);
    console.log(`    Title:    ${config.approval.title}`);
    console.log(`    Assignee: ${config.approval.assignee ?? 'unassigned'}`);
    console.log(
      `    Timeout:  ${config.approval.timeout ? `${config.approval.timeout / 1000}s` : 'none'}`
    );
    if (config.approval.type === 'multi-choice' && config.approval.choices) {
      console.log(`    Choices:  ${config.approval.choices.map((c) => c.label).join(', ')}`);
    }
    console.log();
  }

  approvalStore.dispose();
  await cog.close();
  console.log('Done.');
}

main();
