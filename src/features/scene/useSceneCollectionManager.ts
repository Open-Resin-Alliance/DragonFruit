import { useState, useCallback, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadStlGeometry, type GeometryWithBounds } from '@/hooks/useStlGeometry';
import { clearPaintToBase } from '@/components/analysis/MeshPainter';
import { loadFromLychee } from '@/supports/state';
import { getSettings } from '@/supports/Settings/state';
import type { SelectionHighlightMode } from '@/components/selection';
import { registerDeleteHandler } from '@/features/delete/deleteRegistry';
import type { ModelTransform } from '@/hooks/useModelTransform';
import type { SupportMode } from '@/supports/types';
import { useLycheeImport, type LycheeImportResult } from '@/features/lys-conversion/useLycheeImport';
import { accelerateGeometry } from '@/utils/bvh';

export interface LoadedModel {
  id: string;
  name: string;
  fileUrl: string;
  geometry: GeometryWithBounds;
  transform: ModelTransform;
  visible: boolean;
  color: string;
  polygonCount: number;
}

type DebugPrimitiveType =
  | 'pillar'
  | 'merge_y'
  | 'split_y'
  | 'earlobe'
  | 'bridge'
  | 'finger_palm_arm';

type DebugPrimitiveSizePreset = 'small' | 'medium' | 'large';

import { getSnapshot } from '@/supports/state';
import { deleteSupportsForModel } from '@/supports/PlacementLogic/SupportModelLinker';
import { clearSelection } from '@/supports/interaction/SupportSelection';

export function useSceneCollectionManager() {
  const [models, setModels] = useState<LoadedModel[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);

  const isDebugModelName = useCallback((name: string) => name.startsWith('[Debug]'), []);

  const tryRevokeObjectUrl = useCallback((url: string) => {
    if (!url) return;
    if (!url.startsWith('blob:')) return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore invalid URLs
    }
  }, []);

  const getDebugPresetDims = useCallback((preset: DebugPrimitiveSizePreset) => {
    switch (preset) {
      case 'small':
        return { height: 20, radius: 2.5, span: 10 };
      case 'large':
        return { height: 60, radius: 6, span: 25 };
      case 'medium':
      default:
        return { height: 40, radius: 4, span: 16 };
    }
  }, []);

  const buildDebugGeometry = useCallback((type: DebugPrimitiveType, preset: DebugPrimitiveSizePreset): GeometryWithBounds => {
    const { height, radius, span } = getDebugPresetDims(preset);

    const parts: THREE.BufferGeometry[] = [];

    const makeCylinderZ = (r: number, h: number, radialSegments = 24) => {
      const g = new THREE.CylinderGeometry(r, r, h, radialSegments, 1, false);
      // CylinderGeometry is Y-up; rotate so height is Z-up
      g.rotateX(Math.PI / 2);
      return g;
    };

    const makeBox = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
    const makeSphere = (r: number, segments = 24) => new THREE.SphereGeometry(r, segments, segments);

    const applyTransform = (g: THREE.BufferGeometry, position: THREE.Vector3, rotation: THREE.Euler) => {
      const m = new THREE.Matrix4().makeRotationFromEuler(rotation);
      m.setPosition(position);
      g.applyMatrix4(m);
      return g;
    };

    if (type === 'pillar') {
      parts.push(makeCylinderZ(radius, height));
    }

    if (type === 'merge_y') {
      const branchH = height * 0.7;
      const topH = height * 0.5;
      const tilt = 0.45;
      const xOff = span * 0.35;
      const mergeZ = -height * 0.05;

      parts.push(applyTransform(makeCylinderZ(radius, branchH), new THREE.Vector3(-xOff, 0, -branchH * 0.25), new THREE.Euler(0, +tilt, 0)));
      parts.push(applyTransform(makeCylinderZ(radius, branchH), new THREE.Vector3(+xOff, 0, -branchH * 0.25), new THREE.Euler(0, -tilt, 0)));
      parts.push(applyTransform(makeCylinderZ(radius, topH), new THREE.Vector3(0, 0, mergeZ + topH * 0.35), new THREE.Euler(0, 0, 0)));
    }

    if (type === 'split_y') {
      const trunkH = height * 0.6;
      const branchH = height * 0.55;
      const tilt = 0.45;
      const xOff = span * 0.35;
      const splitZ = height * 0.05;

      parts.push(applyTransform(makeCylinderZ(radius, trunkH), new THREE.Vector3(0, 0, -trunkH * 0.15), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeCylinderZ(radius, branchH), new THREE.Vector3(-xOff, 0, splitZ + branchH * 0.15), new THREE.Euler(0, -tilt, 0)));
      parts.push(applyTransform(makeCylinderZ(radius, branchH), new THREE.Vector3(+xOff, 0, splitZ + branchH * 0.15), new THREE.Euler(0, +tilt, 0)));
    }

    if (type === 'earlobe') {
      const massR = radius * 2.0;
      const nubR = radius * 0.8;
      parts.push(applyTransform(makeSphere(massR), new THREE.Vector3(0, 0, 0), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeSphere(nubR), new THREE.Vector3(span * 0.55, 0, -height * 0.1), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeCylinderZ(radius * 1.2, height * 0.6), new THREE.Vector3(0, 0, -height * 0.55), new THREE.Euler(0, 0, 0)));
    }

    if (type === 'bridge') {
      const block = span * 0.6;
      const blockH = height * 0.5;
      const gap = span * 0.2;
      const bridgeW = gap + radius * 1.2;
      const bridgeT = radius * 0.5;
      parts.push(applyTransform(makeBox(block, block, blockH), new THREE.Vector3(-(block + gap) * 0.5, 0, 0), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeBox(block, block, blockH), new THREE.Vector3(+(block + gap) * 0.5, 0, 0), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeBox(bridgeW, bridgeT, bridgeT), new THREE.Vector3(0, 0, 0), new THREE.Euler(0, 0, 0)));
    }

    if (type === 'finger_palm_arm') {
      const fingerR = radius * 0.7;
      const palmW = span * 0.9;
      const palmT = radius * 2;
      const armR = radius * 1.2;

      parts.push(applyTransform(makeCylinderZ(fingerR, height * 0.6), new THREE.Vector3(-span * 0.35, 0, -height * 0.25), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeCylinderZ(fingerR, height * 0.6), new THREE.Vector3(0, 0, -height * 0.25), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeCylinderZ(fingerR, height * 0.6), new THREE.Vector3(+span * 0.35, 0, -height * 0.25), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeBox(palmW, palmW * 0.5, palmT), new THREE.Vector3(0, 0, height * 0.05), new THREE.Euler(0, 0, 0)));
      parts.push(applyTransform(makeCylinderZ(armR, height * 0.9), new THREE.Vector3(0, 0, height * 0.55), new THREE.Euler(0, 0, 0)));
    }

    const merged = mergeGeometries(parts, false);
    if (!merged) {
      throw new Error('Failed to merge debug primitive geometry');
    }

    const geometry = new THREE.BufferGeometry().copy(merged);

    geometry.computeVertexNormals();
    geometry.computeBoundingBox();

    // Match STL normalization approach so all downstream logic behaves the same.
    const preBBox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
    const preCenter = preBBox.getCenter(new THREE.Vector3());
    geometry.translate(-preCenter.x, -preBBox.min.y, -preCenter.z);
    geometry.computeBoundingBox();

    accelerateGeometry(geometry);

    const bbox = geometry.boundingBox ? geometry.boundingBox.clone() : new THREE.Box3();
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());

    return { geometry, bbox, center, size };
  }, [getDebugPresetDims]);

  const addDebugPrimitive = useCallback((type: DebugPrimitiveType, preset: DebugPrimitiveSizePreset) => {
    const typeLabelMap: Record<DebugPrimitiveType, string> = {
      pillar: 'Pillar',
      merge_y: 'Merge Y',
      split_y: 'Split Y',
      earlobe: 'Earlobe',
      bridge: 'Bridge',
      finger_palm_arm: 'Finger → Palm → Arm'
    };

    const geom = buildDebugGeometry(type, preset);

    const color = '#a3a3a3';
    clearPaintToBase(geom.geometry, new THREE.Color(color));

    const heightOffset = geom.center.z - geom.bbox.min.z;
    const initialZ = heightOffset;

    const id = generateId();
    const model: LoadedModel = {
      id,
      name: `[Debug] ${typeLabelMap[type]}`,
      fileUrl: '',
      geometry: geom,
      transform: {
        position: new THREE.Vector3(0, 0, initialZ),
        rotation: new THREE.Euler(0, 0, 0),
        scale: new THREE.Vector3(1, 1, 1)
      },
      visible: true,
      color,
      polygonCount: geom.geometry.getAttribute('position').count / 3
    };

    setModels(prev => [...prev, model]);
    setActiveModelId(id);
  }, [buildDebugGeometry]);

  const clearDebugModels = useCallback(() => {
    setModels(prev => {
      for (const m of prev) {
        if (isDebugModelName(m.name)) {
          tryRevokeObjectUrl(m.fileUrl);
        }
      }
      return prev.filter(m => !isDebugModelName(m.name));
    });

    setActiveModelId(prevId => {
      if (!prevId) return prevId;
      const stillExists = models.some(m => m.id === prevId && !isDebugModelName(m.name));
      return stillExists ? prevId : null;
    });
  }, [isDebugModelName, models, tryRevokeObjectUrl]);

  // Lighting controls (Global)
  const [ambientIntensity, setAmbientIntensity] = useState<number>(0.6);
  const [directionalIntensity, setDirectionalIntensity] = useState<number>(0.8);
  const [materialRoughness, setMaterialRoughness] = useState<number>(0.65);

  // Global application mode
  const [mode, setMode] = useState<SupportMode>('prepare');
  const [selectionHighlightMode, setSelectionHighlightMode] = useState<SelectionHighlightMode>('spotlight');

  // Helper to generate IDs
  const generateId = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);

  // Active model derived state
  const activeModel = useMemo(() =>
    models.find(m => m.id === activeModelId) || null
    , [models, activeModelId]);

  // Clear support selection when switching away from support mode
  useEffect(() => {
    if (mode !== 'support') {
      clearSelection();
    }
  }, [mode]);

  // File handling - support multiple files
  const loadFiles = useCallback(async (files: FileList) => {
    // Read auto-lift settings from storage (mirroring useTransformManager logic)
    let autoLift = false;
    let liftDistance = 5;
    if (typeof window !== 'undefined') {
      try {
        const savedLift = window.localStorage.getItem('autoLift');
        if (savedLift) autoLift = JSON.parse(savedLift);
        const savedDist = window.localStorage.getItem('liftDistance');
        if (savedDist) liftDistance = parseFloat(savedDist);
      } catch { }
    }

    const newModels: LoadedModel[] = [];

    // Process sequentially to avoid freezing UI too much
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const url = URL.createObjectURL(file);

      try {
        console.log(`[SceneCollection] Loading ${file.name}...`);
        const geom = await loadStlGeometry(url);

        // Initialize paint
        const color = '#a3a3a3'; // Default color
        clearPaintToBase(geom.geometry, new THREE.Color(color));

        // Calculate initial transform with auto-lift
        // By default, loaded geometry is centered at 0,0,0 but bottom might be < 0 or > 0 depending on normalization.
        // loadStlGeometry normalizes: center X/Z at 0, set bottom Y (mapped to Z here?) to 0?
        // Wait, loadStlGeometry: geometry.translate(-preCenter.x, -preBBox.min.y, -preCenter.z);
        // This puts the bottom at Y=0.
        // When rendered, we use Y-up or Z-up? SceneCanvas uses Z-up logic in some places, but Three.js is Y-up.
        // StlMesh rotates geometry? No.
        // Let's assume standard orientation: we want bottom at Z=0 (platform) or Z=liftDistance.
        // Since loadStlGeometry normalizes bottom to Y=0, and we usually rotate meshes -90X or similar...
        // Actually, `loadStlGeometry` normalizes it such that "bottom" is at Y=0.
        // In `SceneCanvas` / `StlMesh`, we render it directly.
        // If the model is oriented Z-up (common for 3D printing), `loadStlGeometry` might have put it on its side if it used Y for height.
        // Let's check `loadStlGeometry` normalization: `geometry.translate(-preCenter.x, -preBBox.min.y, -preCenter.z);`
        // This zeroes the Y minimum.

        // The `computeLowestZ` util takes a matrix.
        // Default transform is identity.
        // If we assume the model is upright after load (or we don't rotate it yet), the lowest point is 0.

        // However, `useTransformManager` uses `computeLowestZ` to find the world Z bottom.
        // If we want to lift it, we set Z position.

        // Let's calculate the default Z position.
        // If the geometry is already normalized to sit at 0, then:
        // platformZ = 0.
        // liftZ = liftDistance.

        // But wait, `StlMesh` applies `centerOffset` to the geometry: 
        // `position={new THREE.Vector3(-centerOffset.x, -centerOffset.y, -centerOffset.z)}`
        // `centerOffset` is `bbox.getCenter()`.
        // So the mesh is centered at (0,0,0) inside the group.
        // The group is at `transform.position`.
        // So if we want the bottom of the mesh to be at `targetZ`, we need to know the distance from center to bottom.
        // halfHeight = (max.z - min.z) / 2.
        // targetGroupZ = targetZ + halfHeight.

        // Wait, `useTransformManager` uses `computeLowestZ`.
        // Let's stick to the logic that `useTransformManager` uses, but applied initially.
        // Actually, `useTransformManager` logic:
        // `const heightOffset = center.z - bbox.min.z;`
        // `const finalZ = autoLift ? heightOffset + liftDistance : heightOffset;`

        // So we replicate that logic.
        const bbox = geom.bbox;
        const center = geom.center;
        const heightOffset = center.z - bbox.min.z;
        const initialZ = autoLift ? heightOffset + liftDistance : heightOffset;

        const model: LoadedModel = {
          id: generateId(),
          name: file.name,
          fileUrl: url,
          geometry: geom,
          transform: {
            position: new THREE.Vector3(0, 0, initialZ),
            rotation: new THREE.Euler(0, 0, 0),
            scale: new THREE.Vector3(1, 1, 1)
          },
          visible: true,
          color,
          polygonCount: geom.geometry.getAttribute('position').count / 3
        };

        newModels.push(model);
      } catch (err) {
        console.error(`Failed to load ${file.name}`, err);
        URL.revokeObjectURL(url); // Cleanup if failed
      }
    }

    if (newModels.length > 0) {
      setModels(prev => [...prev, ...newModels]);
      // If no active model, select the first new one
      if (!activeModelId) {
        setActiveModelId(newModels[0].id);
      }
    }
  }, [activeModelId]);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      loadFiles(e.target.files);
      e.target.value = ''; // Reset input
    }
  }, [loadFiles]);

  // Model Management
  const updateModelTransform = useCallback((id: string, transform: ModelTransform) => {
    setModels(prev => prev.map(m =>
      m.id === id ? { ...m, transform } : m
    ));
  }, []);

  const setModelVisibility = useCallback((id: string, visible: boolean) => {
    setModels(prev => prev.map(m =>
      m.id === id ? { ...m, visible } : m
    ));
  }, []);

  const renameModel = useCallback((id: string, name: string) => {
    setModels(prev => prev.map(m =>
      m.id === id ? { ...m, name } : m
    ));
  }, []);

  const deleteModel = useCallback((id: string) => {
    setModels(prev => {
      const model = prev.find(m => m.id === id);
      if (model) {
        tryRevokeObjectUrl(model.fileUrl);
      }
      const newModels = prev.filter(m => m.id !== id);
      return newModels;
    });

    if (activeModelId === id) {
      setActiveModelId(null);
    }

    // Clean up associated supports
    const supportState = getSnapshot();
    const removedSupports = deleteSupportsForModel(supportState, id);
    console.log(`[SceneCollection] Deleted model ${id} and ${removedSupports} associated supports.`);

  }, [activeModelId]);

  // Legacy Lychee loader wrapper
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

  // New Import Handler for Lychee Files (Legacy - single step)
  const importLycheeSupportFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const json = JSON.parse(text);

      // Determine if it's raw Lychee (has 'supports') or pre-converted Dragonfruit (has 'trunks')
      // But here we assume raw Lychee as per the goal.
      // LysConverter.convert handles the Raw Lychee structure.
      // Dynamic import to avoid circular deps if any (though usually fine here)
      const { LysConverter } = await import('@/features/lys-conversion/LysConverter');

      console.log('[SceneCollection] Converting Lychee file...');
      const converted = LysConverter.convert(json, getSettings());

      console.log('[SceneCollection] Loading into Store...');
      loadFromLychee(converted);

    } catch (err) {
      console.error('[SceneCollection] Failed to import Lychee file:', err);
    }
  }, []);

  // Two-Step Lychee Import (JSON -> STL -> Apply Transforms -> Create Supports)
  const lycheeImport = useLycheeImport();

  const handleLycheeModelLoaded = useCallback((result: LycheeImportResult) => {
    // Create model from the import result
    const color = '#a3a3a3';
    clearPaintToBase(result.geometry.geometry, new THREE.Color(color));

    const model: LoadedModel = {
      id: result.modelId,
      name: 'Lychee Import',
      fileUrl: '', // No URL for imported models
      geometry: result.geometry,
      transform: {
        position: result.transform.position,
        rotation: result.transform.rotation,
        scale: result.transform.scale
      },
      visible: true,
      color,
      polygonCount: result.geometry.geometry.getAttribute('position').count / 3
    };

    setModels(prev => [...prev, model]);
    setActiveModelId(result.modelId);

    console.log('[SceneCollection] Lychee import complete:', {
      modelId: result.modelId,
      supports: result.supportCount
    });
  }, []);

  const handleLycheeStlFile = useCallback((file: File) => {
    lycheeImport.processStlFile(file, handleLycheeModelLoaded);
  }, [lycheeImport.processStlFile, handleLycheeModelLoaded]);

  // Delete Handler Integration
  useEffect(() => {
    const unregister = registerDeleteHandler(
      () => mode === 'prepare' && activeModelId !== null,
      () => {
        if (activeModelId) {
          deleteModel(activeModelId);
        }
      },
      10 // Priority
    );
    return () => { unregister(); };
  }, [activeModelId, deleteModel, mode]);

  // Helper accessors for active model (compatibility)
  const activeMeshColor = activeModel?.color ?? '#a3a3a3';
  const activeMeshVisible = activeModel?.visible ?? true;
  const activeFileName = activeModel?.name ?? null;

  const setMeshColor = useCallback((color: string) => {
    if (activeModelId) {
      setModels(prev => prev.map(m => m.id === activeModelId ? { ...m, color } : m));
      // Persistence could be added here
    }
  }, [activeModelId]);

  const setMeshVisible = useCallback((visible: boolean) => {
    if (activeModelId) {
      setModelVisibility(activeModelId, visible);
    }
  }, [activeModelId, setModelVisibility]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      models.forEach(m => tryRevokeObjectUrl(m.fileUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Calculate global scene bounds for slicing/camera
  const sceneBounds = useMemo(() => {
    if (models.length === 0) return null;

    const unionBox = new THREE.Box3();
    let hasVisible = false;

    for (const model of models) {
      if (!model.visible) continue;

      // Clone bbox to not mutate original
      const modelBox = model.geometry.bbox.clone();
      const center = model.geometry.center; // This is the pre-calculated center of bbox

      // 1. Center the box (matches StlMesh behavior: geometry rendered at -centerOffset)
      modelBox.translate(new THREE.Vector3(-center.x, -center.y, -center.z));

      // 2. Apply model transform
      const t = model.transform;
      const matrix = new THREE.Matrix4().compose(
        t.position,
        new THREE.Quaternion().setFromEuler(t.rotation),
        t.scale
      );

      modelBox.applyMatrix4(matrix);

      // 3. Union
      if (!hasVisible) {
        unionBox.copy(modelBox);
        hasVisible = true;
      } else {
        unionBox.union(modelBox);
      }
    }

    return hasVisible ? unionBox : null;
  }, [models]);

  return {
    models,
    activeModelId,
    setActiveModelId,
    activeModel,

    // Active Model Compatibility helpers
    fileName: activeFileName,
    meshColor: activeMeshColor,
    setMeshColor,
    meshVisible: activeMeshVisible,
    setMeshVisible,
    geom: activeModel?.geometry ?? null,
    polygonCount: activeModel?.polygonCount ?? 0,

    // Scene context
    sceneBounds,

    // Actions
    loadFiles,
    onFileChange,
    updateModelTransform,
    setModelVisibility,
    renameModel,
    deleteModel,

    // Scene settings
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

    // Legacy/Other
    handleLoadLychee,
    importLycheeSupportFile,

    // Two-Step Lychee Import
    lycheeImportPhase: lycheeImport.phase,
    lycheeImportError: lycheeImport.error,
    handleLycheeJsonFile: lycheeImport.processJsonFile,
    handleLycheeStlFile,
    cancelLycheeImport: lycheeImport.cancelImport,

    // Debug primitives
    addDebugPrimitive,
    clearDebugModels
  };
}
