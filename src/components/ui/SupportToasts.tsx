import React from 'react';

export function SupportToasts({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div 
      className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-600 text-white px-4 py-2 rounded-lg shadow-lg text-sm font-medium z-50 transition-all duration-200 ease-out"
      style={{ animation: 'fadeIn 0.2s ease-out' }}
    >
      {message}
    </div>
  );
}
