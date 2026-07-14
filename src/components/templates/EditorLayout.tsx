import React from 'react';

export type EditorLayoutProps = {
  /** Top bar, floating panels, 3D scene, context menu, modals, and toasts —
   *  rendered as overlay siblings inside the full-viewport editor shell. */
  children: React.ReactNode;
};

/** Full-viewport editor shell. The atomic-design "template" layer: it owns the
 *  page layout skeleton (size, overflow, window-drag opt-out) and hosts the
 *  TopBar / panel stacks / scene / modals / toasts as children. */
export function EditorLayout({ children }: EditorLayoutProps) {
  return (
    <div className="ui-shell relative h-screen w-screen overflow-hidden" data-no-window-drag="true">
      {children}
    </div>
  );
}
