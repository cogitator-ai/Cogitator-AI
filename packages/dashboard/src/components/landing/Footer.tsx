'use client';

import { motion } from 'framer-motion';
import { Github, BookOpen, MessageCircle, Cpu, ChefHat } from 'lucide-react';

const links = [
  { name: 'GitHub', href: 'https://github.com/cogitator-ai/Cogitator-AI', icon: Github },
  { name: 'Docs', href: '/docs', icon: BookOpen },
  { name: 'Cookbook', href: '/cookbook', icon: ChefHat },
  { name: 'Discord', href: 'https://discord.gg/SkmRsYvA', icon: MessageCircle },
];

export function Footer() {
  return (
    <footer className="relative py-16 px-6 border-t border-[#1a1a1a]">
      <div className="max-w-6xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="flex flex-col md:flex-row items-center justify-between gap-8"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#00ff88]/10 flex items-center justify-center">
              <Cpu className="w-6 h-6 text-[#00ff88]" />
            </div>
            <div>
              <span className="font-semibold text-[#fafafa]">Cogitator</span>
              <p className="text-xs text-[#666666]">Built for engineers who trust their agents</p>
            </div>
          </div>

          <div className="flex items-center gap-6">
            {links.map((link) => (
              <a
                key={link.name}
                href={link.href}
                target={link.href.startsWith('http') ? '_blank' : undefined}
                rel={link.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                className="flex items-center gap-2 text-sm text-[#a1a1a1] hover:text-[#00ff88] transition-colors"
              >
                <link.icon className="w-4 h-4" />
                {link.name}
              </a>
            ))}
          </div>

          <div className="text-sm text-[#666666]">© {new Date().getFullYear()} • MIT License</div>
        </motion.div>
      </div>
    </footer>
  );
}
