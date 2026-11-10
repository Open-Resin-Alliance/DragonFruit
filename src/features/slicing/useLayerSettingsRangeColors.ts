'use client';

import { useLayoutEffect, useState } from 'react';
import * as THREE from 'three';
import type { LayerSettingsRange } from './layerSettingsRanges';

type RangeColorTheme = { light: boolean; preferred: string[] };
const PREFERRED_TOKENS = ['--accent-secondary', '--success', '--danger'] as const;

function normalizeHex(value: string): string | null {
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex.slice(1);
  if (/^#[0-9a-f]{3}$/.test(hex)) return [...hex.slice(1)].map((digit) => digit + digit).join('');
  return null;
}

/** Scene-order colors shared by bands, context menus and the range editor. */
export function useLayerSettingsRangeColors(ranges: readonly LayerSettingsRange[]): ReadonlyMap<string, string> {
  const rangeIds = JSON.stringify(ranges.map((range) => range.id));
  const [theme, setTheme] = useState<RangeColorTheme | null>(null);
  const [colors, setColors] = useState<ReadonlyMap<string, string>>(() => new Map());

  useLayoutEffect(() => {
    const root = document.documentElement;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const evaluateTheme = () => {
      const explicitTheme = root.getAttribute('data-theme');
      const light = explicitTheme === 'light' || (explicitTheme !== 'dark' && mediaQuery.matches);
      const styles = window.getComputedStyle(root);
      const preferred: string[] = [];
      for (const token of PREFERRED_TOKENS) {
        const hex = normalizeHex(styles.getPropertyValue(token));
        if (hex !== null && !preferred.includes(hex)) preferred.push(hex);
      }
      setTheme((previous) => previous?.light === light && previous.preferred.join(',') === preferred.join(',')
        ? previous
        : { light, preferred });
    };
    evaluateTheme();
    const observer = new MutationObserver(evaluateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', evaluateTheme);
    } else {
      mediaQuery.addListener(evaluateTheme);
    }
    return () => {
      observer.disconnect();
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', evaluateTheme);
      } else {
        mediaQuery.removeListener(evaluateTheme);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (theme === null) return;
    const ids: string[] = JSON.parse(rangeIds);
    const next = new Map<string, string>();
    const used = new Set<string>();
    const color = new THREE.Color();
    let k = 0;
    for (let index = 0; index < ids.length; index += 1) {
      let hex = theme.preferred[index];
      if (hex === undefined) {
        do {
          const cycle = Math.floor(k / 360);
          const hue = ((k + 1) * 0.6180339887498949) % 1;
          const saturation = 0.65 + 0.20 * ((cycle * 0.6180339887498949) % 1);
          const lightness = (theme.light ? 0.35 : 0.55) + (theme.light ? 0.15 : 0.20) * ((cycle * 0.4142135623730951) % 1);
          color.setHSL(hue, saturation, lightness, THREE.SRGBColorSpace);
          hex = color.getHexString(THREE.SRGBColorSpace);
          k += 1;
        } while (used.has(hex));
      }
      used.add(hex);
      next.set(ids[index], `#${hex}`);
    }
    setColors(next);
  }, [rangeIds, theme]);

  return colors;
}
