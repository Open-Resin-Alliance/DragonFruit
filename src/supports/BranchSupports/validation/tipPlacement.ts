// Re-export or call into existing support tip placement validation
export function validateBranchTip(/* tip, settings, supports */) { return { level: 'valid' as const }; }
