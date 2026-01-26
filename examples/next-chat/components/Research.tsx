'use client';

import { useCogitatorAgent } from '@cogitator-ai/next/client';
import { useState } from 'react';

export function Research() {
  const [query, setQuery] = useState('');

  const { run, result, isLoading, error, reset } = useCogitatorAgent({
    api: '/api/agent',
    onSuccess: (res) => {
      console.log('Research complete:', res.output.substring(0, 100));
    },
    onError: (err) => {
      console.error('Research error:', err);
    },
    retry: {
      maxRetries: 1,
      delay: 2000,
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim() && !isLoading) {
      run({ input: query });
    }
  };

  return (
    <div className="research-container">
      <div className="research-header">
        <h2>Research Agent</h2>
        <p>Non-streaming batch requests for longer tasks</p>
      </div>

      <form onSubmit={handleSubmit} className="research-form">
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Enter your research query..."
          disabled={isLoading}
          rows={3}
        />
        <div className="form-actions">
          <button type="submit" disabled={!query.trim() || isLoading}>
            {isLoading ? 'Researching...' : 'Research'}
          </button>
          {result && (
            <button type="button" onClick={reset} className="reset-button">
              Clear Result
            </button>
          )}
        </div>
      </form>

      {error && <div className="error-banner">Error: {error.message}</div>}

      {isLoading && (
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Researching your query...</p>
        </div>
      )}

      {result && (
        <div className="result">
          <div className="result-header">
            <h3>Research Results</h3>
            <div className="result-meta">
              <span>Tokens: {result.usage.totalTokens}</span>
              {result.toolCalls.length > 0 && <span>Tools used: {result.toolCalls.length}</span>}
            </div>
          </div>

          <div className="result-content">{result.output}</div>

          {result.toolCalls.length > 0 && (
            <div className="tool-calls">
              <h4>Tool Calls</h4>
              {result.toolCalls.map((tc, i) => (
                <div key={i} className="tool-call">
                  <span className="tool-name">{tc.name}</span>
                  <code>{JSON.stringify(tc.arguments)}</code>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <style jsx>{`
        .research-container {
          max-width: 800px;
          margin: 0 auto;
          padding: 1rem;
        }

        .research-header {
          margin-bottom: 1.5rem;
        }

        .research-header h2 {
          margin: 0 0 0.5rem 0;
        }

        .research-header p {
          color: #888;
          margin: 0;
        }

        .research-form {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .research-form textarea {
          padding: 1rem;
          background: #222;
          border: 1px solid #444;
          border-radius: 8px;
          color: #fff;
          font-size: 1rem;
          font-family: inherit;
          resize: vertical;
        }

        .research-form textarea:focus {
          outline: none;
          border-color: #ffd700;
        }

        .form-actions {
          display: flex;
          gap: 0.5rem;
        }

        .form-actions button {
          padding: 0.75rem 1.5rem;
          background: #ffd700;
          border: none;
          border-radius: 8px;
          color: #000;
          font-weight: 600;
          cursor: pointer;
        }

        .form-actions button:disabled {
          background: #555;
          color: #888;
          cursor: not-allowed;
        }

        .reset-button {
          background: transparent !important;
          border: 1px solid #555 !important;
          color: #ccc !important;
        }

        .error-banner {
          padding: 0.75rem 1rem;
          background: #4a2020;
          color: #f88;
          border-radius: 4px;
          margin-top: 1rem;
        }

        .loading-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 2rem;
          color: #888;
        }

        .spinner {
          width: 40px;
          height: 40px;
          border: 3px solid #333;
          border-top-color: #ffd700;
          border-radius: 50%;
          animation: spin 1s linear infinite;
          margin-bottom: 1rem;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        .result {
          margin-top: 1.5rem;
          border: 1px solid #333;
          border-radius: 8px;
          overflow: hidden;
        }

        .result-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1rem;
          background: #222;
          border-bottom: 1px solid #333;
        }

        .result-header h3 {
          margin: 0;
          font-size: 1rem;
        }

        .result-meta {
          display: flex;
          gap: 1rem;
          font-size: 0.875rem;
          color: #888;
        }

        .result-content {
          padding: 1rem;
          white-space: pre-wrap;
          line-height: 1.6;
        }

        .tool-calls {
          padding: 1rem;
          background: #1a1a1a;
          border-top: 1px solid #333;
        }

        .tool-calls h4 {
          margin: 0 0 0.75rem 0;
          font-size: 0.875rem;
          color: #888;
        }

        .tool-call {
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
      `}</style>
    </div>
  );
}
