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
 * The chevron that expands and collapses a panel card. Twenty-four copies
 * existed with a hand-drawn `<svg>`; eighteen of them hinted through an
 * untranslated `title` and none carried an `aria-label`, so the accessible name
 * only existed for a mouse user.
 */
export function PanelCollapseToggle({ expanded, onToggle, className }: PanelCollapseToggleProps) {
  const { _ } = useLingui();
  const label = expanded ? _(msg`Collapse card`) : _(msg`Expand card`);
  const Icon = expanded ? ChevronDown : ChevronRight;

  return (
    <IconButton
      variant="ghost"
      size="xs"
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
