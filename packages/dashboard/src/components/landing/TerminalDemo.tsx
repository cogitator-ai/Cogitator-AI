'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

const terminalLines = [
  { type: 'command', text: '$ cogitator run researcher --input "Latest WebGPU news"' },
  { type: 'output', text: '' },
  { type: 'agent', text: '[Agent] researcher → Initializing...' },
  { type: 'agent', text: '[Agent] researcher → Analyzing query...' },
  { type: 'tool', text: '[Tool]  web_search → Searching 3 sources...' },
  { type: 'tool', text: '[Tool]  web_search → Found 12 results' },
  { type: 'agent', text: '[Agent] researcher → Synthesizing findings...' },
  { type: 'output', text: '' },
  { type: 'model', text: '[Model] llama3.2:70b • 2,847 tokens • $0.004' },
  { type: 'output', text: '' },
  { type: 'result', text: '✓ WebGPU achieved full support in Chrome 121...' },
  { type: 'result', text: '✓ Firefox Nightly now supports compute shaders...' },
  { type: 'result', text: '✓ Safari 17.4 adds WebGPU for macOS Sonoma...' },
  { type: 'output', text: '' },
  { type: 'success', text: '[Done] Completed in 3.2s' },
];

const getLineColor = (type: string) => {
  switch (type) {
    case 'command':
      return 'text-[#fafafa]';
    case 'agent':
      return 'text-[#00ff88]';
    case 'tool':
      return 'text-[#00aaff]';
    case 'model':
      return 'text-[#a1a1a1]';
    case 'result':
      return 'text-[#00ff88]';
    case 'success':
      return 'text-[#00ff88] font-semibold';
    default:
      return 'text-[#a1a1a1]';
  }
};

export function TerminalDemo() {
  const [visibleLines, setVisibleLines] = useState<number>(0);
  const [currentText, setCurrentText] = useState<string>('');
  const [isTyping, setIsTyping] = useState(true);

  useEffect(() => {
    if (visibleLines >= terminalLines.length) {
      setTimeout(() => {
        setVisibleLines(0);
        setCurrentText('');
        setIsTyping(true);
      }, 4000);
      return;
    }

    const currentLine = terminalLines[visibleLines];
    if (!currentLine) return;

    if (currentLine.text === '') {
      setTimeout(() => {
        setVisibleLines((v) => v + 1);
        setCurrentText('');
      }, 100);
      return;
    }

    if (currentText.length < currentLine.text.length) {
      const speed = currentLine.type === 'command' ? 30 : 15;
      const timeout = setTimeout(() => {
        setCurrentText(currentLine.text.slice(0, currentText.length + 1));
      }, speed + Math.random() * 20);
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
      className="relative w-full max-w-2xl mx-auto"
    >
      <div className="absolute -inset-[1px] bg-gradient-to-r from-[#00ff88]/50 via-[#00aaff]/50 to-[#00ff88]/50 rounded-xl blur-sm opacity-50" />
      <div className="absolute -inset-[1px] bg-gradient-to-r from-[#00ff88]/30 via-[#00aaff]/30 to-[#00ff88]/30 rounded-xl" />

      <div className="relative bg-[#0a0a0a] rounded-xl overflow-hidden border border-[#262626]">
        <div className="flex items-center gap-2 px-4 py-3 bg-[#111111] border-b border-[#262626]">
          <div className="w-3 h-3 rounded-full bg-[#ff4444]" />
          <div className="w-3 h-3 rounded-full bg-[#ffaa00]" />
          <div className="w-3 h-3 rounded-full bg-[#00ff88]" />
          <span className="ml-2 text-xs text-[#666666] font-mono">
            cogitator — bash
          </span>
        </div>

        <div className="p-4 font-mono text-sm leading-relaxed h-[320px] overflow-hidden">
          <div className="absolute inset-0 pointer-events-none opacity-[0.03]"
            style={{
              backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,136,0.03) 2px, rgba(0,255,136,0.03) 4px)',
            }}
          />

          {terminalLines.slice(0, visibleLines).map((line, i) => (
            <div key={i} className={`${getLineColor(line.type)} whitespace-pre`}>
              {line.text}
            </div>
          ))}

          {visibleLines < terminalLines.length && terminalLines[visibleLines] && (
            <div className={`${getLineColor(terminalLines[visibleLines].type)} whitespace-pre`}>
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
