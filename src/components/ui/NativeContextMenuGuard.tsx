'use client';

import React from 'react';

/**
 * Keeps the webview's own context menu (Reload, and Inspect Element in preview
 * builds) from opening on app chrome. A right-click that no component turned
 * into a menu of its own used to fall through to it, and Reload there throws
 * away the scene.
 *
 * The native menu stays where it does a job, and behind a modifier:
 * - text fields and selected text keep Cut / Copy / Paste;
 * - Alt (Option) + right-click opens it anywhere, which is how a preview build
 *   still reaches Inspect Element.
 */
export function shouldKeepNativeContextMenu(
  event: Pick<MouseEvent, 'altKey' | 'target'>,
  selectedText: string,
): boolean {
  if (event.altKey) return true;
  if (selectedText.trim() !== '') return true;
  const target = event.target;
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return (target as Element).closest('input, textarea, [contenteditable=""], [contenteditable="true"]') !== null;
}

export function NativeContextMenuGuard() {
  React.useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      if (shouldKeepNativeContextMenu(event, window.getSelection()?.toString() ?? '')) return;
      event.preventDefault();
    };

    // Bubble phase on window, so it runs after React's handlers: a component that
    // opens its own menu has had its turn, and a capture-phase guard elsewhere is
    // not second-guessed.
    window.addEventListener('contextmenu', handleContextMenu);
    return () => window.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  return null;
}
