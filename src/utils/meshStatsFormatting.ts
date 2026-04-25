/**
 * Utility functions for formatting mesh statistics and geometry display
 */

export interface MeshStats {
  polygonCount: number;
  componentCount?: number;
}

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

/**
 * Formats stats for display in UI
 * e.g., "1.37M polys • 3 shells" or just "1.37M polys"
 */
export function formatMeshStatsForDisplay(stats: MeshStats): string {
  const polyText = `${formatPolygonCountCompact(stats.polygonCount)} polys`;
  
  // Only show shell count if > 1 (single continuous shells are the desired result)
  if (stats.componentCount != null && stats.componentCount > 1) {
    return `${polyText} • ${stats.componentCount} shells`;
  }
  
  return polyText;
}
