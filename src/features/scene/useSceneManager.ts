import { useState, useCallback, useEffect } from 'react';
import * as THREE from 'three';
import { useStlGeometry } from '@/hooks/useStlGeometry';
import { clearPaintToBase } from '@/components/analysis/MeshPainter';
import { loadFromLychee } from '@/supports/state';
import type { SelectionHighlightMode } from '@/components/selection';
import { registerDeleteHandler } from '@/features/delete/deleteRegistry';

export function useSceneManager() {
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [meshColor, setMeshColor] = useState<string>('#a3a3a3');
  const [meshVisible, setMeshVisible] = useState<boolean>(true);
  
  // Lighting controls
  const [ambientIntensity, setAmbientIntensity] = useState<number>(0.6);
  const [directionalIntensity, setDirectionalIntensity] = useState<number>(0.8);
  const [materialRoughness, setMaterialRoughness] = useState<number>(0.65);

  // Global application mode
  const [mode, setMode] = useState<'prepare' | 'support'>('prepare');
  const [selectionHighlightMode, setSelectionHighlightMode] = useState<SelectionHighlightMode>('spotlight');

  // Geometry hook
  const geom = useStlGeometry(fileUrl);

  // Polygon count computation
  const polygonCount = geom?.geometry?.getAttribute('position')?.count 
    ? geom.geometry.getAttribute('position').count / 3 
    : 0;

  // File handling
  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    setFileUrl(url);
    setFileName(f.name);
    setMeshVisible(true);
    e.target.value = '';
  }, []);

  const handleLoadLychee = async () => {
    try {
      const res = await fetch('/dragonfruit_supports.json');
      const data = await res.json();
      loadFromLychee(data);
      console.log('Loaded Lychee data:', data);
    } catch (e) {
      console.error('Failed to load Lychee data:', e);
    }
  };

  // Persistence for meshColor
  const isValidHex = useCallback((s: string) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s), []);
  
  useEffect(() => {
    try {
      const saved = typeof window !== 'undefined' ? window.localStorage.getItem('meshColor') : null;
      if (saved && isValidHex(saved)) setMeshColor(saved);
    } catch { }
  }, [isValidHex]);

  useEffect(() => {
    try {
      if (isValidHex(meshColor)) window.localStorage.setItem('meshColor', meshColor);
    } catch { }
  }, [meshColor, isValidHex]);

  // Initialize/refresh base vertex colors whenever geometry or base color changes
  useEffect(() => {
    if (!geom) return;
    const base = new THREE.Color(meshColor);
    clearPaintToBase(geom.geometry, base);
  }, [geom, meshColor]);

  useEffect(() => {
    const unregister = registerDeleteHandler(
      () => mode === 'prepare' && Boolean(fileUrl),
      () => {
        if (!fileUrl) return;
        try {
          if (fileUrl.startsWith('blob:')) {
            URL.revokeObjectURL(fileUrl);
          }
        } catch {
          // ignore revoke failures
        }
        setFileUrl(null);
        setFileName(null);
        setMeshVisible(false);
      },
      10,
    );

    return () => {
      unregister();
    };
  }, [fileUrl, mode]);

  return {
    fileUrl,
    fileName,
    meshColor,
    setMeshColor,
    meshVisible,
    setMeshVisible,
    ambientIntensity,
    setAmbientIntensity,
    directionalIntensity,
    setDirectionalIntensity,
    materialRoughness,
    setMaterialRoughness,
    mode,
    setMode,
    selectionHighlightMode,
    setSelectionHighlightMode,
    geom,
    polygonCount,
    onFileChange,
    handleLoadLychee
  };
}
