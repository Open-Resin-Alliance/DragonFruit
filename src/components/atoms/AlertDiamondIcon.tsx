/**
 * Alert diamond, for the Overhangs view toggle.
 *
 * Lucide 0.563 has no diamond alert (neither `DiamondAlert` nor `AlertDiamond`),
 * so this is the set's own `Diamond` outline with the alert stem and dot added:
 * same 24 unit grid, 2px stroke, currentColor. Swap it for `DiamondAlert` if
 * lucide ships one.
 */
export function AlertDiamondIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z" />
      <path d="M12 8v5" />
      <path d="M12 16.5h.01" />
    </svg>
  );
}
