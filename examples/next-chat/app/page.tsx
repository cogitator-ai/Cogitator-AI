'use client';

import { useState } from 'react';
import { Chat } from '@/components/Chat';
import { Research } from '@/components/Research';

type Tab = 'chat' | 'research';

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>('chat');

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          padding: '1rem 2rem',
          borderBottom: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.5rem', color: '#ffd700' }}>Cogitator Example</h1>
        <nav style={{ display: 'flex', gap: '0.5rem' }}>
          <TabButton active={activeTab === 'chat'} onClick={() => setActiveTab('chat')}>
            Chat (Streaming)
          </TabButton>
          <TabButton active={activeTab === 'research'} onClick={() => setActiveTab('research')}>
            Research (Batch)
          </TabButton>
        </nav>
      </header>

      <main style={{ flex: 1, overflow: 'hidden' }}>
        {activeTab === 'chat' && <Chat />}
        {activeTab === 'research' && <Research />}
      </main>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '0.5rem 1rem',
        background: active ? '#ffd700' : 'transparent',
        border: active ? 'none' : '1px solid #555',
        borderRadius: '6px',
        color: active ? '#000' : '#ccc',
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
