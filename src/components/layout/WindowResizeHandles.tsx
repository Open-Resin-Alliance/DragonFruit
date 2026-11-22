"use client";

import React from 'react';
import type { Window } from '@tauri-apps/api/window';
import { useIsLinux } from '@/hooks/usePlatform';

type ResizeDirection = Parameters<Window['startResizeDragging']>[0];

const EDGE_PX = 4;
const CORNER_PX = 10;

const ZONES: ReadonlyArray<{ direction: ResizeDirection; cursor: string; style: React.CSSProperties }> = [
  { direction: 'North', cursor: 'ns-resize', style: { top: 0, left: CORNER_PX, right: CORNER_PX, height: EDGE_PX } },
  { direction: 'South', cursor: 'ns-resize', style: { bottom: 0, left: CORNER_PX, right: CORNER_PX, height: EDGE_PX } },
  { direction: 'West', cursor: 'ew-resize', style: { left: 0, top: CORNER_PX, bottom: CORNER_PX, width: EDGE_PX } },
  { direction: 'East', cursor: 'ew-resize', style: { right: 0, top: CORNER_PX, bottom: CORNER_PX, width: EDGE_PX } },
  { direction: 'NorthWest', cursor: 'nwse-resize', style: { top: 0, left: 0, width: CORNER_PX, height: CORNER_PX } },
  { direction: 'NorthEast', cursor: 'nesw-resize', style: { top: 0, right: 0, width: CORNER_PX, height: CORNER_PX } },
  { direction: 'SouthWest', cursor: 'nesw-resize', style: { bottom: 0, left: 0, width: CORNER_PX, height: CORNER_PX } },
  { direction: 'SouthEast', cursor: 'nwse-resize', style: { bottom: 0, right: 0, width: CORNER_PX, height: CORNER_PX } },
];

async function startResize(direction: ResizeDirection): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startResizeDragging(direction);
  } catch {
    // no-op if not available in current runtime/capability
  }
}

/**
 * Resize zones along the window's edges and corners (Linux only).
 *
 * On Linux the main window is undecorated for the custom titlebar, and the
 * window manager gives an undecorated window no resize borders, so it could
 * only be maximized or minimized. A press in one of these thin zones hands the
 * resize to the window manager through `startResizeDragging`. Windows and macOS
 * keep their native resize behaviour. The zones are hidden while the window is
 * maximized, where they would only take clicks from the UI at the screen edges.
 */
export function WindowResizeHandles() {
  const isLinux = useIsLinux();
  const [maximized, setMaximized] = React.useState(false);

  React.useEffect(() => {
    if (!isLinux) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        const sync = async () => {
          const value = await currentWindow.isMaximized();
          if (!disposed) setMaximized(value);
        };
        await sync();
        const off = await currentWindow.onResized(() => {
          void sync();
        });
        if (disposed) off();
        else unlisten = off;
      } catch {
        // not running in the desktop shell
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isLinux]);

  if (!isLinux || maximized) return null;

  return (
    <>
      {ZONES.map((zone) => (
        <div
          key={zone.direction}
          aria-hidden="true"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            void startResize(zone.direction);
          }}
          style={{ position: 'fixed', zIndex: 10000, cursor: zone.cursor, ...zone.style }}
        />
      ))}
    </>
  );
}
