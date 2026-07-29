/**
 * Utility functions for formatting mesh statistics and geometry display
 */

/**
 * Formats a polygon count to a compact display format
 * Examples: 1376686 -> "1.37M", 50000 -> "50K", 999 -> "999"
 */
export function formatPolygonCountCompact(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return `${millions.toFixed(millions >= 10 ? 0 : 2)}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return `${thousands.toFixed(thousands >= 10 ? 0 : 1)}K`;
  }
  return count.toString();
}
