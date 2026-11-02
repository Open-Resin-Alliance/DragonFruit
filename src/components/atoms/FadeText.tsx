import React from 'react';

/**
 * Text that stays on one line and, when it does not fit, fades out at the end —
 * `text-overflow: clip` with a soft edge instead of a hard one or an ellipsis.
 *
 * CSS has no `text-overflow: fade`, and a plain `mask-image` fades the last pixels
 * even when nothing overflowed, which dims short labels. So the truncation is inline
 * (no stylesheet rule to lose) and the mask is applied only once a measurement says
 * `scrollWidth` exceeds `clientWidth`. It re-measures on resize, on text change and
 * when web fonts settle, since a font swap changes the text width without changing
 * the box.
 */
export type FadeTextProps = {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** How many pixels of the trailing edge fade out. */
  fadeWidth?: number;
};

const maskFor = (fadeWidth: number): React.CSSProperties => {
  const gradient = `linear-gradient(to right, #000 calc(100% - ${fadeWidth}px), transparent 100%)`;
  return { maskImage: gradient, WebkitMaskImage: gradient };
};

export function FadeText({ children, className, style, fadeWidth = 18 }: FadeTextProps) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = React.useState(false);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    measure();

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    // A font that loads after first paint widens the text without resizing the box.
    void document.fonts?.ready.then(measure).catch(() => {});

    return () => observer?.disconnect();
  }, [children]);

  return (
    <span
      ref={ref}
      className={className}
      style={{
        display: 'block',
        minWidth: 0,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'clip',
        ...(overflowing ? maskFor(fadeWidth) : {}),
        ...style,
      }}
    >
      {children}
    </span>
  );
}
