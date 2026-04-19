'use client';

import React from 'react';
import {
  DEFAULT_DEMAND_FRAMELOOP_SETTINGS,
  getSavedDemandFrameloopSettings,
  resolveDemandFrameloop,
  subscribeToDemandFrameloopSettings,
  type DemandFrameloopSettings,
} from '@/components/settings/demandFrameloopPreferences';

function readEnvOverride(): string | undefined {
  const raw = process.env.NEXT_PUBLIC_DEMAND_FRAMELOOP;
  if (raw === undefined || raw === '') return undefined;
  return raw;
}

/**
 * Live-reactive resolution of the demand-frameloop mode for the main Canvas.
 * Reads env override → user preference → platform default (OFF this PR).
 *
 * Initialized with defaults on first render (SSR-safe) and hydrated from
 * localStorage in a useEffect. Without this the Canvas' `frameloop` prop
 * would differ between server and client render and React would warn about
 * hydration mismatch.
 *
 * See ARCHITECTURE_AND_HANDOFF.md "R3F rendering contract" section.
 */
export function useDemandFrameloop(): 'demand' | 'always' {
  const [settings, setSettings] = React.useState<DemandFrameloopSettings>(
    DEFAULT_DEMAND_FRAMELOOP_SETTINGS,
  );

  React.useEffect(() => {
    setSettings(getSavedDemandFrameloopSettings());
    return subscribeToDemandFrameloopSettings(() => {
      setSettings(getSavedDemandFrameloopSettings());
    });
  }, []);

  return React.useMemo(() => resolveDemandFrameloop(settings, readEnvOverride()), [settings]);
}

export function useDemandFrameloopSettings(): DemandFrameloopSettings {
  const [settings, setSettings] = React.useState<DemandFrameloopSettings>(
    DEFAULT_DEMAND_FRAMELOOP_SETTINGS,
  );

  React.useEffect(() => {
    setSettings(getSavedDemandFrameloopSettings());
    return subscribeToDemandFrameloopSettings(() => {
      setSettings(getSavedDemandFrameloopSettings());
    });
  }, []);

  return settings;
}
