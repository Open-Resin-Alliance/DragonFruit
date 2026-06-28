function toTitleWords(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function prettifyToken(value: string) {
  return toTitleWords(
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replaceAll('_', ' ')
      .replaceAll('-', ' '),
  );
}

/**
 * Standardizes history labels for display in the UI.
 *
 * Examples:
 * - support:add-trunk -> Support: Add Trunk
 * - transform:scale XZY.stl -> Transform: Scale XZY.stl
 */
export function formatHistoryLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;

  const match = trimmed.match(/^([^:\s]+)\s*:\s*([^\s]+)(?:\s+(.+))?$/);
  if (match) {
    const [, domainRaw, actionRaw, suffixRaw] = match;
    const domain = prettifyToken(domainRaw);
    const action = prettifyToken(actionRaw);
    const suffix = suffixRaw?.trim();
    return suffix
      ? `${domain}: ${action} ${suffix}`
      : `${domain}: ${action}`;
  }

  return prettifyToken(trimmed);
}
