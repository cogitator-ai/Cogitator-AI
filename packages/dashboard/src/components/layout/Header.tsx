'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Bell, Command, LogOut, User, AlertTriangle, AlertCircle, X } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { formatDistanceToNow } from 'date-fns';

interface UserInfo {
  id: string;
  email?: string;
  role: 'admin' | 'user' | 'readonly';
}

interface Notification {
  id: string;
  level: 'warn' | 'error';
  message: string;
  source: string | null;
  created_at: string;
}

export function Header() {
  const router = useRouter();
  const [searchFocused, setSearchFocused] = useState(false);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const notificationsRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (data.user) setUser(data.user);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/logs?limit=20')
      .then((res) => res.json())
      .then((data) => {
        if (data.logs) {
          const alerts = data.logs.filter(
            (log: Notification) => log.level === 'error' || log.level === 'warn'
          );
          setNotifications(alerts.slice(0, 10));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (notificationsRef.current && !notificationsRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
      }
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) {
        setShowProfile(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/login');
    } catch {
      setLoggingOut(false);
    }
  };

  const dismissNotification = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  const userInitial = user?.email?.charAt(0).toUpperCase() || 'U';

  return (
    <header className="h-16 border-b border-border-subtle bg-bg-secondary/80 backdrop-blur-sm flex items-center justify-between px-6">
      <div className="flex-1 max-w-md">
        <div className="relative">
          <Input
            placeholder="Search agents, runs, logs..."
            icon={<Search className="w-4 h-4" />}
            className="pr-20"
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
          />
          {!searchFocused && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 text-text-muted">
              <kbd className="px-1.5 py-0.5 text-xs bg-bg-elevated rounded border border-border-default">
                <Command className="w-3 h-3 inline" />
              </kbd>
              <kbd className="px-1.5 py-0.5 text-xs bg-bg-elevated rounded border border-border-default">
                K
              </kbd>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4">
        <Badge variant="success" pulse>
          Live
        </Badge>

        <div ref={notificationsRef} className="relative">
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            onClick={() => {
              setShowNotifications(!showNotifications);
              setShowProfile(false);
            }}
          >
            <Bell className="w-5 h-5" />
            {notifications.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-error rounded-full text-[10px] font-medium text-white flex items-center justify-center">
                {notifications.length}
              </span>
            )}
          </Button>

          {showNotifications && (
            <div className="absolute right-0 top-full mt-2 w-80 bg-bg-elevated border border-border-default rounded-lg shadow-lg z-50 overflow-hidden">
              <div className="px-4 py-3 border-b border-border-subtle">
                <h3 className="font-medium text-text-primary">Notifications</h3>
              </div>
              {notifications.length === 0 ? (
                <div className="px-4 py-8 text-center text-text-muted text-sm">
                  No new notifications
                </div>
              ) : (
                <div className="max-h-80 overflow-y-auto">
                  {notifications.map((notification) => (
                    <div
                      key={notification.id}
                      className="px-4 py-3 border-b border-border-subtle last:border-b-0 hover:bg-bg-hover transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        {notification.level === 'error' ? (
                          <AlertCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
                        ) : (
                          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-text-primary line-clamp-2">
                            {notification.message}
                          </p>
                          <p className="text-xs text-text-muted mt-1">
                            {notification.source && `${notification.source} • `}
                            {formatDistanceToNow(new Date(notification.created_at), {
                              addSuffix: true,
                            })}
                          </p>
                        </div>
                        <button
                          onClick={() => dismissNotification(notification.id)}
                          className="text-text-muted hover:text-text-primary transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {notifications.length > 0 && (
                <div className="px-4 py-2 border-t border-border-subtle">
                  <button
                    onClick={() => setNotifications([])}
                    className="text-xs text-accent hover:text-accent/80 transition-colors"
                  >
                    Clear all
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div ref={profileRef} className="relative">
          <button
            onClick={() => {
              setShowProfile(!showProfile);
              setShowNotifications(false);
            }}
            className="flex items-center gap-3"
          >
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-accent to-chart-2 flex items-center justify-center text-bg-primary font-semibold text-sm">
              {userInitial}
            </div>
          </button>

          {showProfile && (
            <div className="absolute right-0 top-full mt-2 w-56 bg-bg-elevated border border-border-default rounded-lg shadow-lg z-50 overflow-hidden">
              <div className="px-4 py-3 border-b border-border-subtle">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-accent to-chart-2 flex items-center justify-center text-bg-primary font-semibold">
                    {userInitial}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">
                      {user?.email || 'User'}
                    </p>
                    <p className="text-xs text-text-muted capitalize">{user?.role || 'user'}</p>
                  </div>
                </div>
              </div>
              <div className="py-1">
                <button
                  onClick={() => {
                    setShowProfile(false);
                    router.push('/settings');
                  }}
                  className={cn(
                    'w-full px-4 py-2 text-left text-sm text-text-primary',
                    'hover:bg-bg-hover transition-colors flex items-center gap-3'
                  )}
                >
                  <User className="w-4 h-4 text-text-muted" />
                  Profile Settings
                </button>
                <button
                  onClick={handleLogout}
                  disabled={loggingOut}
                  className={cn(
                    'w-full px-4 py-2 text-left text-sm text-error',
                    'hover:bg-bg-hover transition-colors flex items-center gap-3',
                    loggingOut && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <LogOut className="w-4 h-4" />
                  {loggingOut ? 'Logging out...' : 'Log out'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
