'use client';

import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info' | 'outline';
  size?: 'sm' | 'md';
  pulse?: boolean;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  (
    {
      className,
      variant = 'default',
      size = 'md',
      pulse = false,
      children,
      ...props
    },
    ref
  ) => {
    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center font-medium rounded-full',
          {
            'bg-bg-elevated text-text-secondary': variant === 'default',
            'bg-success/10 text-success': variant === 'success',
            'bg-warning/10 text-warning': variant === 'warning',
            'bg-error/10 text-error': variant === 'error',
            'bg-info/10 text-info': variant === 'info',
            'bg-transparent border border-border-default text-text-secondary':
              variant === 'outline',
            'px-2 py-0.5 text-xs': size === 'sm',
            'px-2.5 py-1 text-xs': size === 'md',
          },
          className
        )}
        {...props}
      >
        {pulse && (
          <span
            className={cn('w-1.5 h-1.5 rounded-full mr-1.5', {
              'bg-success pulse-live': variant === 'success',
              'bg-warning': variant === 'warning',
              'bg-error': variant === 'error',
              'bg-info': variant === 'info',
              'bg-text-tertiary': variant === 'default' || variant === 'outline',
            })}
          />
        )}
        {children}
      </span>
    );
  }
);

Badge.displayName = 'Badge';

