'use client';

import { useEffect } from 'react';
import { syncExperimentsToNative } from '@/features/experiments/syncExperimentsToNative';

/**
 * Always-mounted manager that mirrors the frontend's Experiments state into the
 * Tauri backend at startup and whenever an experiment is toggled, so gated Rust
 * commands can enforce the gate themselves.
 */
export function ExperimentsNativeSync() {
  useEffect(() => syncExperimentsToNative(), []);
  return null;
}
