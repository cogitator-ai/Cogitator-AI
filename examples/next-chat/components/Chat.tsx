'use client';

import { useCogitatorChat } from '@cogitator-ai/next/client';
import { useState } from 'react';

export function Chat() {
  const [showTools, setShowTools] = useState(true);

  const { messages, input, setInput, send, isLoading, error, stop, clearMessages } =
    useCogitatorChat({
      api: '/api/chat',
      onToolCall: (toolCall) => {
        console.log('Tool called:', toolCall.name, toolCall.arguments);
      },
      onToolResult: (result) => {
        console.log('Tool result:', result);
      },
      onFinish: (message) => {
        console.log('Message complete:', message.id);
      },
      onError: (err) => {
        console.error('Chat error:', err);
      },
      retry: {
        maxRetries: 2,
        delay: 1000,
        backoff: 'exponential',
      },
    });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading) {
      send();
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h2>Chat with AI</h2>
        <div className="chat-actions">
          <label>
            <input
              type="checkbox"
              checked={showTools}
              onChange={(e) => setShowTools(e.target.checked)}
            />
            Show tool calls
          </label>
          <button onClick={clearMessages} disabled={isLoading}>
            Clear
          </button>
        </div>
      </div>

      <div className="messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <p>Start a conversation! Try asking:</p>
            <ul>
              <li>&quot;What&apos;s the weather in Tokyo?&quot;</li>
              <li>&quot;Calculate 15% of 280&quot;</li>
              <li>&quot;Tell me a joke&quot;</li>
            </ul>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`message message-${m.role}`}>
            <div className="message-role">{m.role}</div>
            <div className="message-content">{m.content}</div>

            {showTools && m.toolCalls && m.toolCalls.length > 0 && (
              <div className="tool-calls">
                {m.toolCalls.map((tc, i) => (
                  <div key={i} className="tool-call">
                    <span className="tool-name">{tc.name}</span>
                    <code>{JSON.stringify(tc.arguments)}</code>
                    {tc.result && <div className="tool-result">{String(tc.result)}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {isLoading && (
          <div className="message message-assistant loading">
            <div className="typing-indicator">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        )}
      </div>

      {error && <div className="error-banner">Error: {error.message}</div>}

      <form onSubmit={handleSubmit} className="input-form">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          disabled={isLoading}
        />
        {isLoading ? (
          <button type="button" onClick={stop} className="stop-button">
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>

      <style jsx>{`
        .chat-container {
          display: flex;
          flex-direction: column;
          height: 100%;
          max-width: 800px;
          margin: 0 auto;
        }

        .chat-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1rem;
          border-bottom: 1px solid #333;
        }

        .chat-header h2 {
          margin: 0;
          font-size: 1.25rem;
        }

        .chat-actions {
          display: flex;
          gap: 1rem;
          align-items: center;
        }

        .chat-actions label {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.875rem;
          color: #888;
        }

        .chat-actions button {
          padding: 0.5rem 1rem;
          background: transparent;
          border: 1px solid #555;
          color: #ccc;
          border-radius: 4px;
          cursor: pointer;
        }

        .chat-actions button:hover:not(:disabled) {
          background: #333;
        }

        .messages {
          flex: 1;
          overflow-y: auto;
          padding: 1rem;
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .empty-state {
          color: #666;
          text-align: center;
          padding: 2rem;
        }

        .empty-state ul {
          list-style: none;
          padding: 0;
          margin-top: 1rem;
        }

        .empty-state li {
          margin: 0.5rem 0;
          color: #888;
        }

        .message {
          padding: 1rem;
          border-radius: 8px;
          max-width: 80%;
        }

        .message-user {
          background: #2a4a6a;
          align-self: flex-end;
        }

        .message-assistant {
          background: #333;
          align-self: flex-start;
        }

        .message-role {
          font-size: 0.75rem;
          color: #888;
          margin-bottom: 0.5rem;
          text-transform: uppercase;
        }

        .message-content {
          white-space: pre-wrap;
          line-height: 1.5;
        }

        .tool-calls {
          margin-top: 0.75rem;
          padding-top: 0.75rem;
          border-top: 1px solid #444;
        }

        .tool-call {
          font-size: 0.875rem;
          margin-bottom: 0.5rem;
        }

        .tool-name {
          color: #ffd700;
          font-weight: 500;
        }

        .tool-call code {
          display: block;
          margin-top: 0.25rem;
          padding: 0.5rem;
          background: #222;
          border-radius: 4px;
          font-size: 0.75rem;
          color: #aaa;
        }

        .tool-result {
          margin-top: 0.25rem;
          padding: 0.5rem;
          background: #1a3a1a;
          border-radius: 4px;
          font-size: 0.75rem;
          color: #8f8;
        }

        .loading {
          display: flex;
          align-items: center;
        }

        .typing-indicator {
          display: flex;
          gap: 4px;
        }

        .typing-indicator span {
          width: 8px;
          height: 8px;
          background: #666;
          border-radius: 50%;
          animation: bounce 1.4s infinite ease-in-out both;
        }

        .typing-indicator span:nth-child(1) {
          animation-delay: -0.32s;
        }

        .typing-indicator span:nth-child(2) {
          animation-delay: -0.16s;
        }

        @keyframes bounce {
          0%,
          80%,
          100% {
            transform: scale(0);
          }
          40% {
            transform: scale(1);
          }
        }

        .error-banner {
          padding: 0.75rem 1rem;
          background: #4a2020;
          color: #f88;
          border-radius: 4px;
          margin: 0 1rem;
        }

        .input-form {
          display: flex;
          gap: 0.5rem;
          padding: 1rem;
          border-top: 1px solid #333;
        }

        .input-form input {
          flex: 1;
          padding: 0.75rem 1rem;
          background: #222;
          border: 1px solid #444;
          border-radius: 8px;
          color: #fff;
          font-size: 1rem;
        }

        .input-form input:focus {
          outline: none;
          border-color: #ffd700;
        }

        .input-form button {
          padding: 0.75rem 1.5rem;
          background: #ffd700;
          border: none;
          border-radius: 8px;
          color: #000;
          font-weight: 600;
          cursor: pointer;
        }

        .input-form button:disabled {
          background: #555;
          color: #888;
          cursor: not-allowed;
        }

        .stop-button {
          background: #a33 !important;
          color: #fff !important;
        }
      `}</style>
    </div>
  );
}
