import React from 'react';

/**
 * A container for floating UI panels that overlays the canvas.
 * Allows clicking through empty spaces to the canvas below.
 */
export function FloatingPanelStack({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute left-0 top-[56px] z-10 flex flex-col max-h-[calc(100vh-56px)] min-w-64 w-fit max-w-[100vw] pointer-events-none">
      {/* Inner scroll container with padding for shadows */}
      <div className="flex flex-col gap-2 overflow-y-auto custom-scrollbar pr-0 pb-2">
         {React.Children.map(children, child => 
            child ? <div className="pointer-events-auto flex-shrink-0">{child}</div> : null
         )}
      </div>
    </div>
  );
}
