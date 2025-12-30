'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import {
  LayoutDashboard,
  Bot,
  Play,
  FlaskConical,
  BarChart3,
  ScrollText,
  Settings,
  FileCode,
  Cpu,
  Box,
  GitBranch,
  Users,
  Brain,
} from 'lucide-react';

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Agents', href: '/agents', icon: Bot },
  { name: 'Workflows', href: '/workflows', icon: GitBranch },
  { name: 'Swarms', href: '/swarms', icon: Users },
  { name: 'Runs', href: '/runs', icon: Play },
  { name: 'Memory', href: '/memory', icon: Brain },
  { name: 'Models', href: '/models', icon: Box },
  { name: 'Playground', href: '/playground', icon: FlaskConical },
  { name: 'Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'Logs', href: '/logs', icon: ScrollText },
  { name: 'Config', href: '/config', icon: FileCode },
];

const bottomNavigation = [{ name: 'Settings', href: '/settings', icon: Settings }];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 bg-bg-secondary border-r border-border-subtle flex flex-col">
      {/* Logo */}
      <div className="h-16 flex items-center px-4 border-b border-border-subtle">
        <Link href="/" className="flex items-center gap-3 group">
          <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center group-hover:bg-accent/20 transition-colors">
            <Cpu className="w-5 h-5 text-accent" />
          </div>
          <span className="font-semibold text-lg text-text-primary">
            Cogitator
          </span>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {navigation.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200',
                isActive
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
              )}
            >
              <item.icon
                className={cn(
                  'w-5 h-5',
                  isActive ? 'text-accent' : 'text-text-tertiary'
                )}
              />
              {item.name}
              {isActive && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-accent" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Bottom Navigation */}
      <div className="p-3 border-t border-border-subtle space-y-1">
        {bottomNavigation.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200',
                isActive
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
              )}
            >
              <item.icon
                className={cn(
                  'w-5 h-5',
                  isActive ? 'text-accent' : 'text-text-tertiary'
                )}
              />
              {item.name}
            </Link>
          );
        })}

        {/* Version */}
        <div className="px-3 py-2 text-xs text-text-muted">v0.1.0</div>
      </div>
    </aside>
  );
}
