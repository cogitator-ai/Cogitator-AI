import { NextRequest } from 'next/server';
import { getSubscriber, CHANNELS } from '@/lib/redis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHANNEL_TO_EVENT: Record<string, string> = {
  [CHANNELS.RUN_STARTED]: 'run',
  [CHANNELS.RUN_COMPLETED]: 'run',
  [CHANNELS.RUN_FAILED]: 'run',
  [CHANNELS.TOOL_CALL]: 'run',
  [CHANNELS.LOG_ENTRY]: 'log',
  [CHANNELS.AGENT_STATUS]: 'agent',
};

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      const subscriber = await getSubscriber();
      
      const sendEvent = (event: string, data: unknown) => {
        const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(message));
      };

      // Send heartbeat
      const heartbeat = setInterval(() => {
        sendEvent('heartbeat', { timestamp: Date.now() });
      }, 30000);

      // Subscribe to channels
      const channels = Object.values(CHANNELS);
      
      try {
        for (const channel of channels) {
          await subscriber.subscribe(channel);
        }

        subscriber.on('message', (channel: string, message: string) => {
          try {
            const data = JSON.parse(message);
            const eventName = CHANNEL_TO_EVENT[channel] || channel.split(':').pop() || 'message';
            
            // Add event type based on channel
            let eventType: string | undefined;
            if (channel === CHANNELS.RUN_STARTED) eventType = 'started';
            else if (channel === CHANNELS.RUN_COMPLETED) eventType = 'completed';
            else if (channel === CHANNELS.RUN_FAILED) eventType = 'failed';
            else if (channel === CHANNELS.TOOL_CALL) eventType = 'toolCall';
            
            sendEvent(eventName, {
              ...data,
              type: eventType,
              channel,
            });
          } catch {
            sendEvent('message', { raw: message, channel });
          }
        });

        // Send initial connection event
        sendEvent('connected', { 
          channels,
          timestamp: Date.now(),
        });

        // Handle client disconnect
        request.signal.addEventListener('abort', async () => {
          clearInterval(heartbeat);
          for (const channel of channels) {
            await subscriber.unsubscribe(channel);
          }
        });
      } catch (error) {
        console.error('Redis subscription error:', error);
        sendEvent('error', { message: 'Failed to connect to Redis' });
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
