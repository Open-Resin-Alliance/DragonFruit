"use client";

import React from 'react';

export function Sidebar({ children, widthClass = "w-72" }: { children: React.ReactNode; widthClass?: string }) {
  return (
    <div className={`fixed left-0 ${widthClass} border-r border-neutral-800 bg-neutral-900 z-20`} style={{ top: '56px', bottom: 0 }}>
      <div className="h-full overflow-y-auto p-4 space-y-4">
        {children}
      </div>
    </div>
  );
}
