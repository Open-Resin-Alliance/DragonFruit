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

/**
 * Formats a file size with the unit that suits it. The mesh files themselves are
 * quoted in megabytes, but a small STL printed as "0.0 MB" tells the reader
 * nothing, so the ladder steps down to KB and up to GB.
 *
 * Lifted from the model stats card, which had the only copy while two other
 * components kept their own — this is the one to call.
 */
export function formatFileSize(bytes: number | null | undefined): string | null {
  // Zero means "not known" rather than "empty": a path-backed import used to
  // report 0 for its size, and printing "0 B" for a mesh that plainly has bytes
  // is worse than printing nothing.
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const abs = Math.max(0, bytes);
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;

  if (abs >= GB) return `${(abs / GB).toFixed(2)} GB`;
  if (abs >= MB) return `${(abs / MB).toFixed(2)} MB`;
  if (abs >= KB) return `${(abs / KB).toFixed(1)} KB`;
  return `${abs.toFixed(0)} B`;
}
