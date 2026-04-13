import React from 'react';
import { Toast } from '@/components/ui/primitives';

export function SupportToasts({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="absolute top-4 left-1/2 z-50 -translate-x-1/2">
      <Toast
        tone="error"
        shape="rounded"
        className="transition-all duration-200 ease-out"
        style={{ animation: 'fadeIn 0.2s ease-out' }}
      >
        {message}
      </Toast>
    </div>
  );
}
