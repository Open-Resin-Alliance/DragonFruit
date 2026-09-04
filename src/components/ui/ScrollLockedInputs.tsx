'use client';

import React from 'react';

/**
 * Prevents text inputs and textareas from scrolling their content when the
 * user hovers over them and uses the mouse wheel — unless the field is
 * actively focused or the Shift key is held.
 *
 * Number inputs are intentionally skipped; the ScrollableNumberField
 * component uses its own non-passive wheel listener to step values and
 * already calls preventDefault().
 */
const SCROLLABLE_INPUT_SELECTOR = [
  'input[type="text"]',
  'input[type="search"]',
  'input[type="url"]',
  'input[type="email"]',
  'input[type="password"]',
  'input:not([type])',   // defaults to "text"
  'textarea',
  '[contenteditable="true"]',
].join(',');

function isScrollableInput(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  if (!target || !(target instanceof HTMLElement)) return false;
  return target.matches(SCROLLABLE_INPUT_SELECTOR);
}

export function ScrollLockedInputs() {
  React.useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (!isScrollableInput(event.target)) return;
      if (event.shiftKey) return; // Shift+scroll = deliberate scroll
      if (document.activeElement === event.target) return; // focused = deliberate

      event.preventDefault();
    };

    // Capture phase so we cancel before the browser starts scrolling the input.
    document.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => document.removeEventListener('wheel', handleWheel, { capture: true });
  }, []);

  return null;
}
