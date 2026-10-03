'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';

type LineType = 'command' | 'step' | 'note' | 'output' | 'dim' | 'blank';

interface TerminalLine {
  type: LineType;
  text: string;
}

const terminalLines: TerminalLine[] = [
  {
    type: 'command',
    text: '$ npx create-cogitator-app my-agents -t basic -p ollama --pm pnpm --no-docker --git',
  },
  { type: 'step', text: "┌  Let's build something with AI agents" },
  { type: 'step', text: '◇  Generated project files' },
  { type: 'step', text: '◇  Installed dependencies' },
  { type: 'step', text: '◇  Initialized git repository' },
  { type: 'note', text: '└  Done! Next steps:' },
  { type: 'dim', text: '     cd my-agents' },
  { type: 'dim', text: '     pnpm dev' },
  { type: 'blank', text: '' },
  { type: 'command', text: '$ cd my-agents && pnpm start' },
  {
    type: 'output',
    text: 'Cogitator is a self-hosted AI agent runtime for TypeScript. An agent pairs a model with instructions and tools, and the runtime loops through tool calls until it can answer.',
  },
  { type: 'blank', text: '' },
  {
    type: 'command',
    text: '$ npx @cogitator-ai/cli run -m ollama/qwen3:8b "One use case for a DAG workflow?"',
  },
  { type: 'dim', text: 'Using config: /home/dev/my-agents/cogitator.yml' },
  {
    type: 'output',
    text: 'Document intake: extract, classify and summarize in parallel, then wait for a human to approve before publishing.',
  },
];

const lineColors: Record<LineType, string> = {
  command: 'text-[#fafafa]',
  step: 'text-[#00aaff]',
  note: 'text-[#00ff88]',
  output: 'text-[#d4d4d4]',
  dim: 'text-[#666666]',
  blank: 'text-[#a1a1a1]',
};

export function TerminalDemo() {
  const [visibleLines, setVisibleLines] = useState<number>(0);
  const [currentText, setCurrentText] = useState<string>('');
  const screenRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const screen = screenRef.current;
    if (screen) screen.scrollTop = screen.scrollHeight;
  }, [visibleLines, currentText]);

  useEffect(() => {
    if (visibleLines >= terminalLines.length) {
      const timeout = setTimeout(() => {
        setVisibleLines(0);
        setCurrentText('');
      }, 4000);
      return () => clearTimeout(timeout);
    }

    const currentLine = terminalLines[visibleLines];
    if (!currentLine) return;

    if (currentLine.text === '') {
      const timeout = setTimeout(() => {
        setVisibleLines((v) => v + 1);
        setCurrentText('');
      }, 100);
      return () => clearTimeout(timeout);
    }

    if (currentText.length < currentLine.text.length) {
      const speed = currentLine.type === 'command' ? 30 : 8;
      const timeout = setTimeout(
        () => {
          setCurrentText(currentLine.text.slice(0, currentText.length + 1));
        },
        speed + Math.random() * 20
      );
      return () => clearTimeout(timeout);
    } else {
      const delay = currentLine.type === 'command' ? 800 : 300;
      const timeout = setTimeout(() => {
        setVisibleLines((v) => v + 1);
        setCurrentText('');
      }, delay);
      return () => clearTimeout(timeout);
    }
  }, [visibleLines, currentText]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, delay: 0.5 }}
      className="relative w-full max-w-3xl mx-auto"
    >
      <div className="absolute -inset-[1px] bg-gradient-to-r from-[#00ff88]/50 via-[#00aaff]/50 to-[#00ff88]/50 rounded-xl blur-sm opacity-50" />
      <div className="absolute -inset-[1px] bg-gradient-to-r from-[#00ff88]/30 via-[#00aaff]/30 to-[#00ff88]/30 rounded-xl" />

      <div className="relative bg-[#0a0a0a] rounded-xl overflow-hidden border border-[#262626]">
        <div className="flex items-center gap-2 px-4 py-3 bg-[#111111] border-b border-[#262626]">
          <div className="w-3 h-3 rounded-full bg-[#ff4444]" />
          <div className="w-3 h-3 rounded-full bg-[#ffaa00]" />
          <div className="w-3 h-3 rounded-full bg-[#00ff88]" />
          <span className="ml-2 text-xs text-[#666666] font-mono">~/projects — zsh</span>
        </div>

        <div
          ref={screenRef}
          className="p-4 font-mono text-xs sm:text-sm leading-relaxed h-[360px] sm:h-[420px] overflow-hidden"
        >
          <div
            className="absolute inset-0 pointer-events-none opacity-[0.03]"
            style={{
              backgroundImage:
                'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,136,0.03) 2px, rgba(0,255,136,0.03) 4px)',
            }}
          />

          {terminalLines.slice(0, visibleLines).map((line, i) => (
            <div key={i} className={`${lineColors[line.type]} whitespace-pre-wrap break-words`}>
              {line.text}
            </div>
          ))}

          {visibleLines < terminalLines.length && terminalLines[visibleLines] && (
            <div
              className={`${lineColors[terminalLines[visibleLines].type]} whitespace-pre-wrap break-words`}
            >
              {currentText}
              <motion.span
                animate={{ opacity: [1, 0] }}
                transition={{ duration: 0.5, repeat: Infinity }}
                className="inline-block w-2 h-4 bg-[#00ff88] ml-0.5 align-middle"
              />
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
