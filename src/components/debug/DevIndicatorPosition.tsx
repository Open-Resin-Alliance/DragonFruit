"use client";

import { useEffect } from 'react';

// Horizontal offset for the Next.js dev tools indicator ("N" badge). At its
// default top-right spot it sits on top of the app's Settings gear in the top
// bar; 160px further left it lands in the free gap between the Print stage
// button and the camera controls.
const INDICATOR_RIGHT_PX = 180; // default 20px + 160px shift

/**
 * Moves the Next.js dev tools indicator out of the top bar's action cluster.
 *
 * `devIndicators.position` only supports the four corners, so this reaches
 * into the indicator's shadow root and pins `right` with !important, which
 * wins over the inline style Next re-applies on badge state changes. Renders
 * nothing and does nothing in production builds, where the indicator does
 * not exist.
 */
export function DevIndicatorPosition() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;

    const inject = () => {
      const shadowRoot = document.querySelector('nextjs-portal')?.shadowRoot;
      if (!shadowRoot || shadowRoot.querySelector('[data-dragonfruit-indicator-offset]')) return;
      const style = document.createElement('style');
      style.setAttribute('data-dragonfruit-indicator-offset', 'true');
      style.textContent = `#devtools-indicator { right: ${INDICATOR_RIGHT_PX}px !important; }`;
      shadowRoot.appendChild(style);
    };

    // The portal may not exist yet on mount, and dev overlays can recreate
    // it, so re-inject whenever the top-level DOM changes.
    inject();
    const observer = new MutationObserver(inject);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
