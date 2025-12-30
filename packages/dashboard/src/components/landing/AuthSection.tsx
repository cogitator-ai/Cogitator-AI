'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Github, Mail, Loader2, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

interface AuthSectionProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AuthSection({ isOpen, onClose }: AuthSectionProps) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const supabase = createClient();

  const handleGitHubLogin = async () => {
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      setError(error.message);
      setLoading(false);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    if (mode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        setError(error.message);
        setLoading(false);
      } else {
        window.location.href = '/dashboard';
      }
    } else {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          data: { role: 'user' },
        },
      });
      if (error) {
        setError(error.message);
      } else {
        setSuccess('Check your email for the confirmation link');
      }
      setLoading(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50"
            onClick={onClose}
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md"
          >
            <div className="absolute -inset-[1px] bg-gradient-to-b from-[#00ff88]/30 via-[#00ff88]/10 to-transparent rounded-2xl" />

            <div className="relative bg-[#0a0a0a] rounded-2xl border border-[#262626] p-8 overflow-hidden">
              <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[#00ff88]/50 to-transparent" />

              <div className="absolute inset-0 opacity-[0.02]"
                style={{
                  backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,136,0.1) 2px, rgba(0,255,136,0.1) 4px)',
                }}
              />

              <div className="relative z-10">
                <h2 className="text-2xl font-bold text-[#fafafa] mb-2 text-center">
                  {mode === 'login' ? 'Welcome back' : 'Create account'}
                </h2>
                <p className="text-[#a1a1a1] text-sm text-center mb-8">
                  {mode === 'login'
                    ? 'Sign in to access your dashboard'
                    : 'Start orchestrating AI agents'}
                </p>

                <button
                  onClick={handleGitHubLogin}
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-[#fafafa] text-[#0a0a0a] rounded-xl font-medium hover:bg-[#e0e0e0] transition-colors disabled:opacity-50"
                >
                  {loading ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <Github className="w-5 h-5" />
                  )}
                  Continue with GitHub
                </button>

                <div className="flex items-center gap-4 my-6">
                  <div className="flex-1 h-[1px] bg-[#262626]" />
                  <span className="text-xs text-[#666666] uppercase tracking-wider">
                    or
                  </span>
                  <div className="flex-1 h-[1px] bg-[#262626]" />
                </div>

                <form onSubmit={handleEmailAuth} className="space-y-4">
                  <div>
                    <label className="block text-sm text-[#a1a1a1] mb-2">
                      Email
                    </label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[#666666]" />
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@company.com"
                        required
                        className="w-full pl-11 pr-4 py-3 bg-[#111111] border border-[#262626] rounded-xl text-[#fafafa] placeholder-[#666666] focus:outline-none focus:border-[#00ff88] focus:ring-1 focus:ring-[#00ff88]/20 transition-all"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm text-[#a1a1a1] mb-2">
                      Password
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        required
                        minLength={8}
                        className="w-full pl-4 pr-11 py-3 bg-[#111111] border border-[#262626] rounded-xl text-[#fafafa] placeholder-[#666666] focus:outline-none focus:border-[#00ff88] focus:ring-1 focus:ring-[#00ff88]/20 transition-all"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[#666666] hover:text-[#a1a1a1] transition-colors"
                      >
                        {showPassword ? (
                          <EyeOff className="w-5 h-5" />
                        ) : (
                          <Eye className="w-5 h-5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-3 bg-[#ff4444]/10 border border-[#ff4444]/30 rounded-lg text-sm text-[#ff4444]"
                    >
                      {error}
                    </motion.div>
                  )}

                  {success && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-3 bg-[#00ff88]/10 border border-[#00ff88]/30 rounded-lg text-sm text-[#00ff88]"
                    >
                      {success}
                    </motion.div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[#00ff88] text-[#0a0a0a] rounded-xl font-semibold hover:bg-[#00dd77] transition-colors disabled:opacity-50 group"
                  >
                    {loading ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <>
                        {mode === 'login' ? 'Sign in' : 'Create account'}
                        <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                      </>
                    )}
                  </button>
                </form>

                <p className="mt-6 text-center text-sm text-[#666666]">
                  {mode === 'login' ? (
                    <>
                      Don&apos;t have an account?{' '}
                      <button
                        onClick={() => {
                          setMode('signup');
                          setError(null);
                          setSuccess(null);
                        }}
                        className="text-[#00ff88] hover:underline"
                      >
                        Sign up
                      </button>
                    </>
                  ) : (
                    <>
                      Already have an account?{' '}
                      <button
                        onClick={() => {
                          setMode('login');
                          setError(null);
                          setSuccess(null);
                        }}
                        className="text-[#00ff88] hover:underline"
                      >
                        Sign in
                      </button>
                    </>
                  )}
                </p>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
