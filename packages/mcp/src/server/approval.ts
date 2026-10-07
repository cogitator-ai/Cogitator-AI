import type { ToolApprovalDecision, ToolApprovalRequest } from '@cogitator-ai/types';
import type { MCPToolContext } from '../types';

/**
 * Ask the person at the MCP client whether a tool call that needs approval may run, through
 * elicitation. `undefined` when nobody can be asked (the client does not support elicitation,
 * or the transport cannot carry it), so the caller decides what an unanswered call means.
 */
export async function elicitApproval(
  elicit: MCPToolContext['elicit'],
  request: ToolApprovalRequest
): Promise<ToolApprovalDecision | undefined> {
  if (!elicit) return undefined;
  const reply = await elicit({
    message: `The agent wants to run ${request.toolName} (${request.description}) with ${JSON.stringify(request.arguments)}. Approve?`,
    schema: {
      type: 'object',
      properties: {
        approve: { type: 'boolean', title: 'Approve', default: false },
        reason: { type: 'string', title: 'Reason (if you decline)' },
      },
      required: ['approve'],
    },
  });
  if (!reply) return undefined;
  if (reply.action !== 'accept') return { approved: false, reason: 'The user declined' };
  const reason = typeof reply.content.reason === 'string' ? reply.content.reason : undefined;
  return reply.content.approve === true
    ? { approved: true }
    : { approved: false, ...(reason && { reason }) };
}
