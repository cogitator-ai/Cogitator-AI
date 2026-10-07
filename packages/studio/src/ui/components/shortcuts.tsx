import { X } from 'lucide-react';
import { MOD } from '../hotkeys';
import { Kbd } from './common';

const GROUPS: Array<{ title: string; keys: Array<[string, string[]]> }> = [
  {
    title: 'Everywhere',
    keys: [
      ['Command palette', [MOD, 'K']],
      ['Keyboard shortcuts', ['?']],
      ['Go to the overview', ['G', 'O']],
      ['Go to the runs', ['G', 'R']],
      ['Search the page', ['/']],
    ],
  },
  {
    title: 'Chat',
    keys: [
      ['Send', ['Enter']],
      ['New line', ['Shift', 'Enter']],
      ['New thread', ['N']],
      ['Focus the message box', ['C']],
    ],
  },
  {
    title: 'Runs',
    keys: [
      ['Next and previous run', ['J', 'K']],
      ['Open the run', ['Enter']],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="overlay"
      onMouseDown={onClose}
      onKeyDown={(event) => event.key === 'Escape' && onClose()}
      data-dialog
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            onClick={onClose}
            aria-label="Close"
            autoFocus
          >
            <X size={15} />
          </button>
        </div>
        <div className="dialog-body">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <div className="shortcut-group">{group.title}</div>
              {group.keys.map(([label, keys]) => (
                <div key={label} className="shortcut">
                  <span>{label}</span>
                  <Kbd keys={keys} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
