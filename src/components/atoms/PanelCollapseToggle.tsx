import { ChevronDown, ChevronRight } from 'lucide-react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { IconButton } from './IconButton';

interface PanelCollapseToggleProps {
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}

/**
 * The chevron that expands and collapses a panel card.
 *
 * The hand-written copies were `ui-button ui-button-secondary` with `!p-0.5`
 * alongside the `!p-2` the button atom already carried. Both are `!important`,
 * so the atom's `!p-2` won and the tile rendered 30x30 around a 12px chevron —
 * dropping the padding here would shrink it to 18x18. What the copies did not
 * have is the accessible name and `aria-expanded`, which live here.
 */
export function PanelCollapseToggle({ expanded, onToggle, className }: PanelCollapseToggleProps) {
  const { _ } = useLingui();
  const label = expanded ? _(msg`Collapse card`) : _(msg`Expand card`);
  const Icon = expanded ? ChevronDown : ChevronRight;

  return (
    <IconButton
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      className={className}
    >
      <Icon className="h-3 w-3" style={{ color: expanded ? 'var(--accent)' : 'var(--text-muted)' }} />
    </IconButton>
  );
}
