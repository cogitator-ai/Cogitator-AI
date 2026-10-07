import { useState } from 'react';
import { Braces, Rows3 } from 'lucide-react';
import { CopyButton, JsonBlock } from './common';
import { Markdown } from './markdown';
import { pretty } from '../format';

function isProse(value: unknown): value is string {
  return typeof value === 'string' && (value.length > 80 || value.includes('\n'));
}

/**
 * A workflow state field by field: prose an agent wrote as Markdown, the rest
 * as JSON, with the raw JSON of the whole state a click away.
 */
export function StateView({ value, label }: { value: unknown; label: string }) {
  const [raw, setRaw] = useState(false);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return <JsonBlock label={label} value={value} />;
  const entries = Object.entries(value);
  return (
    <div className="json state">
      <div className="json-head">
        <span>{label}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <div className="seg seg-icons" role="group" aria-label="View">
            <button
              type="button"
              aria-pressed={!raw}
              aria-label="Fields"
              data-tip="Fields"
              onClick={() => setRaw(false)}
            >
              <Rows3 size={12} />
            </button>
            <button
              type="button"
              aria-pressed={raw}
              aria-label="Raw JSON"
              data-tip="Raw JSON"
              onClick={() => setRaw(true)}
            >
              <Braces size={12} />
            </button>
          </div>
          <CopyButton value={pretty(value)} label={`Copy ${label.toLowerCase()}`} />
        </span>
      </div>
      {raw ? (
        <pre>{pretty(value)}</pre>
      ) : (
        <div className="state-fields">
          {entries.length === 0 && <div className="muted">Empty</div>}
          {entries.map(([key, field]) => (
            <div key={key} className="state-field">
              <div className="state-key">{key}</div>
              {isProse(field) ? (
                <div className="state-prose">
                  <Markdown text={field} />
                </div>
              ) : (
                <pre className={`state-value ${typeof field === 'string' ? 'state-text' : ''}`}>
                  {pretty(field)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
