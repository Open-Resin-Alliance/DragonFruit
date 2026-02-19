'use client';

import React from 'react';
import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { rleIntersectDilated, type RleLabels, type RleMask } from '@/volumeAnalysis/IslandScan/rle';
import type { useIslandManager } from '@/volumeAnalysis/IslandScan/useIslandManager';
import { buildVolumeHierarchy } from '../buildVolumeHierarchy';
import type { BuildVolumeHierarchyResult } from '../types';
import { Button, Card, CardHeader } from '@/components/ui/primitives';

interface Props {
  islands: ReturnType<typeof useIslandManager>;
  layerHeightMm: number;
}

export function IslandVolumesHierarchyCard({ islands, layerHeightMm }: Props) {
  const [result, setResult] = React.useState<BuildVolumeHierarchyResult | null>(null);
  const [includeEventNodes, setIncludeEventNodes] = React.useState<boolean>(false);
  const [voxelView, setVoxelView] = React.useState<'nodes' | 'leaves' | 'systems' | 'boundedSystems' | 'boundedCaps'>('nodes');

  const minMergeAreaRatio = 0.10;
  const minMergePersistenceMm = 1.5;

  const applyNodeLabelsToVoxels = React.useCallback((scanData: ScanResults, nodeLabelsPerLayer: RleLabels[]) => {
    islands.setScanData({
      ...scanData,
      territoryLabelsPerLayer: nodeLabelsPerLayer,
    });
    islands.setVoxelShowTerritory(true);
    islands.setVoxelEnabled(true);
  }, [islands]);

  const summary = React.useMemo(() => {
    if (!result) return null;
    const merges = result.edges.filter(e => e.type === 'merge').length;
    const splits = result.edges.filter(e => e.type === 'split').length;
    const births = result.events.filter(e => e.type === 'birth').reduce((sum, e) => sum + e.nodeIds.length, 0);
    const deaths = result.events.filter(e => e.type === 'death').reduce((sum, e) => sum + e.nodeIds.length, 0);
    const incoming = new Map<number, number>();
    const outgoing = new Map<number, number>();
    for (const e of result.edges) {
      incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
      outgoing.set(e.from, (outgoing.get(e.from) ?? 0) + 1);
    }
    let leaves = 0;
    for (const n of result.nodes) {
      if ((incoming.get(n.id) ?? 0) === 0) leaves++;
    }
    const adjacency = new Map<number, Set<number>>();
    for (const n of result.nodes) adjacency.set(n.id, new Set());
    for (const e of result.edges) {
      adjacency.get(e.from)?.add(e.to);
      adjacency.get(e.to)?.add(e.from);
    }
    const visited = new Set<number>();
    let groups = 0;
    for (const n of result.nodes) {
      if (visited.has(n.id)) continue;
      groups++;
      const stack = [n.id];
      visited.add(n.id);
      while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const nb of adjacency.get(cur) ?? []) {
          if (visited.has(nb)) continue;
          visited.add(nb);
          stack.push(nb);
        }
      }
    }
    return { nodes: result.nodes.length, edges: result.edges.length, merges, splits, leaves, births, deaths, issues: result.issues.length, groups };
  }, [result]);

  const logicalVolumes = React.useMemo(() => {
    const scanData = islands.scanData;
    if (!result || !scanData) return [] as Array<{ id: number; firstLayer: number; lastLayer: number; heightMm: number; volumeMm3: number; baseAreaMm2: number }>;

    const pxMm = scanData.grid.px_mm;
    const pxArea = pxMm * pxMm;

    const nodeById = new Map<number, { firstLayer: number; lastLayer: number }>();
    for (const n of result.nodes) nodeById.set(n.id, { firstLayer: n.firstLayer, lastLayer: n.lastLayer });

    const incomingEdgeCount = new Map<number, number>();
    for (const e of result.edges) {
      incomingEdgeCount.set(e.to, (incomingEdgeCount.get(e.to) ?? 0) + 1);
    }

    const nodeStats = new Map<number, { areaPx: number; baseAreaPx: number }>();

    for (let layer = 0; layer < result.nodeLabelsPerLayer.length; layer++) {
      const labels = result.nodeLabelsPerLayer[layer];
      if (!labels) continue;
      for (let y = 0; y < labels.height; y++) {
        const row = labels.rows[y];
        for (let i = 0; i < row.length; i += 3) {
          const len = row[i + 1];
          const id = row[i + 2];
          if (id <= 0) continue;
          let st = nodeStats.get(id);
          if (!st) {
            st = { areaPx: 0, baseAreaPx: 0 };
            nodeStats.set(id, st);
          }
          st.areaPx += len;
          const node = nodeById.get(id);
          if (node && layer === node.firstLayer) {
            st.baseAreaPx += len;
          }
        }
      }
    }

    const rows: Array<{ id: number; firstLayer: number; lastLayer: number; heightMm: number; volumeMm3: number; baseAreaMm2: number }> = [];
    for (const n of result.nodes) {
      const isOwnershipLeaf = (incomingEdgeCount.get(n.id) ?? 0) === 0;
      if (!includeEventNodes && !isOwnershipLeaf) continue;

      const stats = nodeStats.get(n.id) ?? { areaPx: 0, baseAreaPx: 0 };
      const heightMm = (n.lastLayer - n.firstLayer + 1) * layerHeightMm;
      const volumeMm3 = stats.areaPx * pxArea * layerHeightMm;
      const baseAreaMm2 = stats.baseAreaPx * pxArea;
      rows.push({ id: n.id, firstLayer: n.firstLayer, lastLayer: n.lastLayer, heightMm, volumeMm3, baseAreaMm2 });
    }

    rows.sort((a, b) => b.volumeMm3 - a.volumeMm3);
    return rows;
  }, [result, islands.scanData, includeEventNodes, layerHeightMm]);

  const systemVolumes = React.useMemo(() => {
    const scanData = islands.scanData;
    if (!result || !scanData) return [] as Array<{ rootId: number; nodeCount: number; firstLayer: number; lastLayer: number; heightMm: number; volumeMm3: number; baseAreaMm2: number }>;

    const pxMm = scanData.grid.px_mm;
    const pxArea = pxMm * pxMm;

    const nodeById = new Map<number, { firstLayer: number; lastLayer: number }>();
    for (const n of result.nodes) nodeById.set(n.id, { firstLayer: n.firstLayer, lastLayer: n.lastLayer });

    const nodeStats = new Map<number, { areaPx: number; baseAreaPx: number }>();
    for (let layer = 0; layer < result.nodeLabelsPerLayer.length; layer++) {
      const labels = result.nodeLabelsPerLayer[layer];
      if (!labels) continue;
      for (let y = 0; y < labels.height; y++) {
        const row = labels.rows[y];
        for (let i = 0; i < row.length; i += 3) {
          const len = row[i + 1];
          const id = row[i + 2];
          if (id <= 0) continue;
          let st = nodeStats.get(id);
          if (!st) {
            st = { areaPx: 0, baseAreaPx: 0 };
            nodeStats.set(id, st);
          }
          st.areaPx += len;
          const node = nodeById.get(id);
          if (node && layer === node.firstLayer) {
            st.baseAreaPx += len;
          }
        }
      }
    }

    const children = new Map<number, Set<number>>();
    const addChild = (parentId: number, childId: number) => {
      let set = children.get(parentId);
      if (!set) {
        set = new Set();
        children.set(parentId, set);
      }
      set.add(childId);
    };

    for (const e of result.edges) {
      if (e.type === 'merge') {
        addChild(e.to, e.from);
      } else {
        addChild(e.from, e.to);
      }
    }

    const mergeRoots = new Set<number>();
    for (const e of result.edges) {
      if (e.type === 'merge') mergeRoots.add(e.to);
    }

    const roots = Array.from(mergeRoots);

    const out: Array<{ rootId: number; nodeCount: number; firstLayer: number; lastLayer: number; heightMm: number; volumeMm3: number; baseAreaMm2: number }> = [];
    for (const rootId of roots) {
      const visited = new Set<number>();
      const stack = [rootId];
      visited.add(rootId);

      let minFirstLayer = Number.POSITIVE_INFINITY;
      let maxLastLayer = Number.NEGATIVE_INFINITY;
      let areaPxSum = 0;

      const baseAreaByFirstLayer = new Map<number, number>();

      while (stack.length > 0) {
        const cur = stack.pop()!;
        const node = nodeById.get(cur);
        if (node) {
          if (node.firstLayer < minFirstLayer) minFirstLayer = node.firstLayer;
          if (node.lastLayer > maxLastLayer) maxLastLayer = node.lastLayer;
          const st = nodeStats.get(cur);
          if (st) {
            areaPxSum += st.areaPx;
            baseAreaByFirstLayer.set(node.firstLayer, (baseAreaByFirstLayer.get(node.firstLayer) ?? 0) + st.baseAreaPx);
          }
        }

        const kids = children.get(cur);
        if (!kids) continue;
        for (const k of kids) {
          if (visited.has(k)) continue;
          visited.add(k);
          stack.push(k);
        }
      }

      if (!Number.isFinite(minFirstLayer) || !Number.isFinite(maxLastLayer)) continue;

      const baseAreaPx = baseAreaByFirstLayer.get(minFirstLayer) ?? 0;
      const heightMm = (maxLastLayer - minFirstLayer + 1) * layerHeightMm;
      const volumeMm3 = areaPxSum * pxArea * layerHeightMm;
      const baseAreaMm2 = baseAreaPx * pxArea;

      out.push({
        rootId,
        nodeCount: visited.size,
        firstLayer: minFirstLayer,
        lastLayer: maxLastLayer,
        heightMm,
        volumeMm3,
        baseAreaMm2,
      });
    }

    out.sort((a, b) => b.volumeMm3 - a.volumeMm3);
    return out;
  }, [result, islands.scanData, layerHeightMm]);

  const systemProfiles = React.useMemo(() => {
    const scanData = islands.scanData;
    if (!result || !scanData) {
      return [] as Array<{ rootId: number; nodeCount: number; firstLayer: number; lastLayer: number; heightMm: number; volumeMm3: number; baseAreaMm2: number; peakAreaMm2: number; peakLayer: number }>;
    }

    const pxMm = scanData.grid.px_mm;
    const pxArea = pxMm * pxMm;

    const numLayers = result.nodeLabelsPerLayer.length;

    const nodeById = new Map<number, { firstLayer: number; lastLayer: number }>();
    for (const n of result.nodes) nodeById.set(n.id, { firstLayer: n.firstLayer, lastLayer: n.lastLayer });

    const nodeAreaPxByLayer = new Map<number, number[]>();
    for (let layer = 0; layer < numLayers; layer++) {
      const labels = result.nodeLabelsPerLayer[layer];
      if (!labels) continue;
      for (let y = 0; y < labels.height; y++) {
        const row = labels.rows[y];
        for (let i = 0; i < row.length; i += 3) {
          const len = row[i + 1];
          const id = row[i + 2];
          if (id <= 0) continue;
          let arr = nodeAreaPxByLayer.get(id);
          if (!arr) {
            arr = new Array(numLayers).fill(0);
            nodeAreaPxByLayer.set(id, arr);
          }
          arr[layer] += len;
        }
      }
    }

    const children = new Map<number, Set<number>>();
    const addChild = (parentId: number, childId: number) => {
      let set = children.get(parentId);
      if (!set) {
        set = new Set();
        children.set(parentId, set);
      }
      set.add(childId);
    };

    for (const e of result.edges) {
      if (e.type === 'merge') {
        addChild(e.to, e.from);
      } else {
        addChild(e.from, e.to);
      }
    }

    const mergeRoots = new Set<number>();
    for (const e of result.edges) {
      if (e.type === 'merge') mergeRoots.add(e.to);
    }

    const out: Array<{ rootId: number; nodeCount: number; firstLayer: number; lastLayer: number; heightMm: number; volumeMm3: number; baseAreaMm2: number; peakAreaMm2: number; peakLayer: number }> = [];

    for (const rootId of mergeRoots) {
      const visited = new Set<number>();
      const stack = [rootId];
      visited.add(rootId);

      let minFirstLayer = Number.POSITIVE_INFINITY;
      let maxLastLayer = Number.NEGATIVE_INFINITY;

      while (stack.length > 0) {
        const cur = stack.pop()!;
        const node = nodeById.get(cur);
        if (node) {
          if (node.firstLayer < minFirstLayer) minFirstLayer = node.firstLayer;
          if (node.lastLayer > maxLastLayer) maxLastLayer = node.lastLayer;
        }
        const kids = children.get(cur);
        if (!kids) continue;
        for (const k of kids) {
          if (visited.has(k)) continue;
          visited.add(k);
          stack.push(k);
        }
      }

      if (!Number.isFinite(minFirstLayer) || !Number.isFinite(maxLastLayer)) continue;

      const systemAreaPxByLayer = new Array(numLayers).fill(0);
      for (const nodeId of visited) {
        const node = nodeById.get(nodeId);
        const arr = nodeAreaPxByLayer.get(nodeId);
        if (!node || !arr) continue;
        for (let layer = node.firstLayer; layer <= node.lastLayer; layer++) {
          systemAreaPxByLayer[layer] += arr[layer] ?? 0;
        }
      }

      const baseAreaPx = systemAreaPxByLayer[minFirstLayer] ?? 0;
      let peakAreaPx = 0;
      let peakLayer = minFirstLayer;
      let areaPxSum = 0;
      for (let layer = minFirstLayer; layer <= maxLastLayer; layer++) {
        const a = systemAreaPxByLayer[layer] ?? 0;
        areaPxSum += a;
        if (a > peakAreaPx) {
          peakAreaPx = a;
          peakLayer = layer;
        }
      }

      const heightMm = (maxLastLayer - minFirstLayer + 1) * layerHeightMm;
      const volumeMm3 = areaPxSum * pxArea * layerHeightMm;
      const baseAreaMm2 = baseAreaPx * pxArea;
      const peakAreaMm2 = peakAreaPx * pxArea;

      out.push({
        rootId,
        nodeCount: visited.size,
        firstLayer: minFirstLayer,
        lastLayer: maxLastLayer,
        heightMm,
        volumeMm3,
        baseAreaMm2,
        peakAreaMm2,
        peakLayer,
      });
    }

    out.sort((a, b) => b.volumeMm3 - a.volumeMm3);
    return out;
  }, [result, islands.scanData, layerHeightMm]);

  const mergeJunctions = React.useMemo(() => {
    const scanData = islands.scanData;
    if (!result || !scanData) {
      return [] as Array<{ parentId: number; childId: number; mergeLayer: number; childPersistenceMm: number; childEndAreaMm2: number; parentStartAreaMm2: number; areaRatio: number }>;
    }

    const pxMm = scanData.grid.px_mm;
    const pxArea = pxMm * pxMm;
    const numLayers = result.nodeLabelsPerLayer.length;

    const nodeById = new Map<number, { firstLayer: number; lastLayer: number }>();
    for (const n of result.nodes) nodeById.set(n.id, { firstLayer: n.firstLayer, lastLayer: n.lastLayer });

    const nodeAreaPxByLayer = new Map<number, number[]>();
    for (let layer = 0; layer < numLayers; layer++) {
      const labels = result.nodeLabelsPerLayer[layer];
      if (!labels) continue;
      for (let y = 0; y < labels.height; y++) {
        const row = labels.rows[y];
        for (let i = 0; i < row.length; i += 3) {
          const len = row[i + 1];
          const id = row[i + 2];
          if (id <= 0) continue;
          let arr = nodeAreaPxByLayer.get(id);
          if (!arr) {
            arr = new Array(numLayers).fill(0);
            nodeAreaPxByLayer.set(id, arr);
          }
          arr[layer] += len;
        }
      }
    }

    const out: Array<{ parentId: number; childId: number; mergeLayer: number; childPersistenceMm: number; childEndAreaMm2: number; parentStartAreaMm2: number; areaRatio: number }> = [];
    for (const e of result.edges) {
      if (e.type !== 'merge') continue;

      const child = nodeById.get(e.from);
      const parent = nodeById.get(e.to);
      if (!child || !parent) continue;

      const mergeLayer = parent.firstLayer;
      const childEndLayer = child.lastLayer;

      const childArr = nodeAreaPxByLayer.get(e.from);
      const parentArr = nodeAreaPxByLayer.get(e.to);

      const childEndAreaPx = childArr ? (childArr[childEndLayer] ?? 0) : 0;
      const parentStartAreaPx = parentArr ? (parentArr[mergeLayer] ?? 0) : 0;

      const childEndAreaMm2 = childEndAreaPx * pxArea;
      const parentStartAreaMm2 = parentStartAreaPx * pxArea;
      const areaRatio = parentStartAreaPx > 0 ? childEndAreaPx / parentStartAreaPx : 0;

      const childPersistenceMm = (child.lastLayer - child.firstLayer + 1) * layerHeightMm;

      out.push({
        parentId: e.to,
        childId: e.from,
        mergeLayer,
        childPersistenceMm,
        childEndAreaMm2,
        parentStartAreaMm2,
        areaRatio,
      });
    }

    out.sort((a, b) => b.areaRatio - a.areaRatio);
    return out;
  }, [result, islands.scanData, layerHeightMm]);

  const mergeProminence = React.useMemo(() => {
    if (!result) return { significant: 0, incidental: 0, significantKeys: new Set<string>() };
    const significantKeys = new Set<string>();
    for (const j of mergeJunctions) {
      if (j.areaRatio >= minMergeAreaRatio && j.childPersistenceMm >= minMergePersistenceMm) {
        significantKeys.add(`${j.childId}->${j.parentId}`);
      }
    }
    const totalMerges = result.edges.filter(e => e.type === 'merge').length;
    const significant = significantKeys.size;
    const incidental = Math.max(0, totalMerges - significant);
    return { significant, incidental, significantKeys };
  }, [mergeJunctions, minMergeAreaRatio, minMergePersistenceMm, result]);

  const significantMergeEdges = React.useMemo(() => {
    if (!result) return [] as Array<{ childId: number; parentId: number; mergeLayer: number }>;

    const nodeById = new Map<number, { firstLayer: number; lastLayer: number }>();
    for (const n of result.nodes) nodeById.set(n.id, { firstLayer: n.firstLayer, lastLayer: n.lastLayer });

    const out: Array<{ childId: number; parentId: number; mergeLayer: number }> = [];
    for (const e of result.edges) {
      if (e.type !== 'merge') continue;
      if (!mergeProminence.significantKeys.has(`${e.from}->${e.to}`)) continue;
      const parent = nodeById.get(e.to);
      if (!parent) continue;
      out.push({ childId: e.from, parentId: e.to, mergeLayer: parent.firstLayer });
    }
    out.sort((a, b) => a.mergeLayer - b.mergeLayer);
    return out;
  }, [mergeProminence.significantKeys, result]);

  const cutoffCandidates = React.useMemo(() => {
    if (!result) {
      return { bySystem: new Map<number, Array<{ childId: number; parentId: number; mergeLayer: number; areaRatio: number; childPersistenceMm: number }>>() };
    }

    const boundedParents = new Map<number, Set<number>>();
    const addParent = (m: Map<number, Set<number>>, child: number, parent: number) => {
      let set = m.get(child);
      if (!set) {
        set = new Set();
        m.set(child, set);
      }
      set.add(parent);
    };

    for (const e of result.edges) {
      if (e.type === 'merge') {
        if (mergeProminence.significantKeys.has(`${e.from}->${e.to}`)) {
          addParent(boundedParents, e.from, e.to);
        }
      } else {
        addParent(boundedParents, e.to, e.from);
      }
    }

    const resolveRoots = (m: Map<number, Set<number>>): Map<number, number> => {
      const rootFor = new Map<number, number>();
      for (const n of result.nodes) {
        if (rootFor.has(n.id)) continue;
        const path: number[] = [];
        const seen = new Set<number>();
        let cur = n.id;
        let resolved: number | null = null;

        while (true) {
          if (rootFor.has(cur)) {
            resolved = rootFor.get(cur)!;
            break;
          }
          if (seen.has(cur)) {
            resolved = cur;
            break;
          }
          seen.add(cur);
          path.push(cur);

          const ps = m.get(cur);
          if (!ps || ps.size === 0) {
            resolved = cur;
            break;
          }

          let bestParent: number | null = null;
          for (const p of ps) {
            if (bestParent === null || p < bestParent) bestParent = p;
          }
          cur = bestParent ?? cur;
        }

        for (const id of path) {
          rootFor.set(id, resolved!);
        }
      }
      return rootFor;
    };

    const boundedRootFor = resolveRoots(boundedParents);

    const bySystem = new Map<number, Array<{ childId: number; parentId: number; mergeLayer: number; areaRatio: number; childPersistenceMm: number }>>();
    const push = (systemId: number, row: { childId: number; parentId: number; mergeLayer: number; areaRatio: number; childPersistenceMm: number }) => {
      let arr = bySystem.get(systemId);
      if (!arr) {
        arr = [];
        bySystem.set(systemId, arr);
      }
      arr.push(row);
    };

    for (const j of mergeJunctions) {
      const key = `${j.childId}->${j.parentId}`;
      const isSignificant = mergeProminence.significantKeys.has(key);
      if (isSignificant) continue;

      const childSys = boundedRootFor.get(j.childId) ?? j.childId;
      const parentSys = boundedRootFor.get(j.parentId) ?? j.parentId;
      if (childSys === parentSys) continue;

      push(childSys, {
        childId: j.childId,
        parentId: j.parentId,
        mergeLayer: j.mergeLayer,
        areaRatio: j.areaRatio,
        childPersistenceMm: j.childPersistenceMm,
      });
    }

    for (const arr of bySystem.values()) {
      arr.sort((a, b) => b.areaRatio - a.areaRatio);
    }

    return { bySystem };
  }, [mergeJunctions, mergeProminence.significantKeys, result]);

  const remappedLabelSets = React.useMemo(() => {
    if (!result) return null as null | { nodes: RleLabels[]; leaves: RleLabels[]; systems: RleLabels[]; boundedSystems: RleLabels[]; boundedCaps: RleLabels[] };

    const incomingEdgeCount = new Map<number, number>();
    for (const e of result.edges) {
      incomingEdgeCount.set(e.to, (incomingEdgeCount.get(e.to) ?? 0) + 1);
    }
    const leafIds = new Set<number>();
    for (const n of result.nodes) {
      if ((incomingEdgeCount.get(n.id) ?? 0) === 0) leafIds.add(n.id);
    }

    const parents = new Map<number, Set<number>>();
    const boundedParents = new Map<number, Set<number>>();
    const addParent = (m: Map<number, Set<number>>, child: number, parent: number) => {
      let set = m.get(child);
      if (!set) {
        set = new Set();
        m.set(child, set);
      }
      set.add(parent);
    };

    for (const e of result.edges) {
      if (e.type === 'merge') {
        addParent(parents, e.from, e.to);
        if (mergeProminence.significantKeys.has(`${e.from}->${e.to}`)) {
          addParent(boundedParents, e.from, e.to);
        }
      } else {
        addParent(parents, e.to, e.from);
        addParent(boundedParents, e.to, e.from);
      }
    }

    const resolveRoots = (m: Map<number, Set<number>>): Map<number, number> => {
      const rootFor = new Map<number, number>();
      for (const n of result.nodes) {
        if (rootFor.has(n.id)) continue;

        const path: number[] = [];
        const seen = new Set<number>();
        let cur = n.id;
        let resolved: number | null = null;

        while (true) {
          if (rootFor.has(cur)) {
            resolved = rootFor.get(cur)!;
            break;
          }
          if (seen.has(cur)) {
            resolved = cur;
            break;
          }
          seen.add(cur);
          path.push(cur);

          const ps = m.get(cur);
          if (!ps || ps.size === 0) {
            resolved = cur;
            break;
          }

          let bestParent: number | null = null;
          for (const p of ps) {
            if (bestParent === null || p < bestParent) bestParent = p;
          }
          cur = bestParent ?? cur;
        }

        for (const id of path) {
          rootFor.set(id, resolved!);
        }
      }
      return rootFor;
    };

    const rootFor = resolveRoots(parents);
    const boundedRootFor = resolveRoots(boundedParents);

    const remap = (labelsPerLayer: RleLabels[], mapId: (id: number) => number): RleLabels[] => {
      const outLayers: RleLabels[] = new Array(labelsPerLayer.length);
      for (let layer = 0; layer < labelsPerLayer.length; layer++) {
        const labels = labelsPerLayer[layer];
        const rows: Int32Array[] = new Array(labels.height);
        for (let y = 0; y < labels.height; y++) {
          const row = labels.rows[y];
          if (row.length === 0) {
            rows[y] = new Int32Array(0);
            continue;
          }
          const outRow: number[] = [];
          for (let i = 0; i < row.length; i += 3) {
            const start = row[i];
            const len = row[i + 1];
            const id = row[i + 2];
            const mapped = mapId(id);
            if (mapped > 0) {
              outRow.push(start, len, mapped);
            }
          }
          rows[y] = new Int32Array(outRow);
        }
        outLayers[layer] = { rows, width: labels.width, height: labels.height };
      }
      return outLayers;
    };

    const nodes = result.nodeLabelsPerLayer;
    const leaves = remap(result.nodeLabelsPerLayer, (id) => (leafIds.has(id) ? id : 0));
    const systems = remap(result.nodeLabelsPerLayer, (id) => rootFor.get(id) ?? 0);
    const boundedSystems = remap(result.nodeLabelsPerLayer, (id) => boundedRootFor.get(id) ?? 0);

    const extractMaskForId = (labels: RleLabels, targetId: number): RleMask => {
      const rows: Int32Array[] = new Array(labels.height);
      for (let y = 0; y < labels.height; y++) {
        const row = labels.rows[y];
        if (row.length === 0) {
          rows[y] = new Int32Array(0);
          continue;
        }
        const outRow: number[] = [];
        for (let i = 0; i < row.length; i += 3) {
          const start = row[i];
          const len = row[i + 1];
          const id = row[i + 2];
          if (id === targetId) {
            outRow.push(start, len);
          }
        }
        rows[y] = new Int32Array(outRow);
      }
      return { rows, width: labels.width, height: labels.height };
    };

    const applyCap = (base: RleLabels, cap: RleMask, capLabelId: number): RleLabels => {
      const width = base.width;
      const outRows: Int32Array[] = new Array(base.height);

      for (let y = 0; y < base.height; y++) {
        const baseRow = base.rows[y];
        const capRow = cap.rows[y];

        if (capRow.length === 0) {
          outRows[y] = baseRow;
          continue;
        }
        if (baseRow.length === 0) {
          const onlyCap: number[] = [];
          for (let j = 0; j < capRow.length; j += 2) {
            const start = capRow[j];
            const len = capRow[j + 1];
            if (len > 0) onlyCap.push(start, len, capLabelId);
          }
          outRows[y] = new Int32Array(onlyCap);
          continue;
        }

        let bIdx = 0;
        let cIdx = 0;
        let pos = 0;

        let bStart = baseRow[bIdx];
        let bEnd = bStart + baseRow[bIdx + 1];
        let bId = baseRow[bIdx + 2];

        let cStart = capRow[cIdx];
        let cEnd = cStart + capRow[cIdx + 1];

        const out: number[] = [];
        const pushRun = (start: number, end: number, id: number) => {
          const len = end - start;
          if (len <= 0 || id <= 0) return;
          if (out.length > 0) {
            const prevStart = out[out.length - 3];
            const prevLen = out[out.length - 2];
            const prevId = out[out.length - 1];
            if (prevId === id && prevStart + prevLen === start) {
              out[out.length - 2] = prevLen + len;
              return;
            }
          }
          out.push(start, len, id);
        };

        while (pos < width) {
          while (bIdx < baseRow.length && pos >= bEnd) {
            bIdx += 3;
            if (bIdx < baseRow.length) {
              bStart = baseRow[bIdx];
              bEnd = bStart + baseRow[bIdx + 1];
              bId = baseRow[bIdx + 2];
            }
          }
          while (cIdx < capRow.length && pos >= cEnd) {
            cIdx += 2;
            if (cIdx < capRow.length) {
              cStart = capRow[cIdx];
              cEnd = cStart + capRow[cIdx + 1];
            }
          }

          const inBase = bIdx < baseRow.length && pos >= bStart && pos < bEnd;
          const inCap = cIdx < capRow.length && pos >= cStart && pos < cEnd;

          const nextBase = inBase ? bEnd : (bIdx < baseRow.length ? bStart : width);
          const nextCap = inCap ? cEnd : (cIdx < capRow.length ? cStart : width);
          const nextPos = Math.min(width, nextBase, nextCap);

          const id = inCap ? capLabelId : (inBase ? bId : 0);
          pushRun(pos, nextPos, id);
          pos = nextPos;
        }

        outRows[y] = new Int32Array(out);
      }

      return { rows: outRows, width: base.width, height: base.height };
    };

    const nodeById = new Map<number, { firstLayer: number; lastLayer: number }>();
    for (const n of result.nodes) nodeById.set(n.id, { firstLayer: n.firstLayer, lastLayer: n.lastLayer });

    const capMaxMm = 4.0;
    const capLayersMax = Math.max(1, Math.round(capMaxMm / layerHeightMm));
    const capRadiusPx = 6;

    const boundedCapsLayers: RleLabels[] = boundedSystems.map((l) => ({ rows: l.rows.slice(), width: l.width, height: l.height }));

    for (const e of significantMergeEdges) {
      const child = nodeById.get(e.childId);
      const parent = nodeById.get(e.parentId);
      if (!child || !parent) continue;

      const childBoundedId = boundedRootFor.get(e.childId) ?? 0;
      if (childBoundedId <= 0) continue;

      const seedLayer = Math.min(child.lastLayer, result.nodeLabelsPerLayer.length - 1);
      let seedMask = extractMaskForId(result.nodeLabelsPerLayer[seedLayer], e.childId);

      for (let layer = e.mergeLayer; layer <= parent.lastLayer && layer < result.nodeLabelsPerLayer.length; layer++) {
        if (layer - e.mergeLayer >= capLayersMax) break;
        const parentMask = extractMaskForId(result.nodeLabelsPerLayer[layer], e.parentId);
        const capMask = rleIntersectDilated(parentMask, seedMask, capRadiusPx);

        let hasAny = false;
        for (let y = 0; y < capMask.height; y++) {
          if (capMask.rows[y].length > 0) { hasAny = true; break; }
        }
        if (!hasAny) break;

        boundedCapsLayers[layer] = applyCap(boundedCapsLayers[layer], capMask, childBoundedId);
        seedMask = capMask;
      }
    }

    return { nodes, leaves, systems, boundedSystems, boundedCaps: boundedCapsLayers };
  }, [layerHeightMm, mergeProminence.significantKeys, result, significantMergeEdges]);

  const applyCurrentVoxelView = React.useCallback((scanData: ScanResults) => {
    if (!result || !remappedLabelSets) return;
    if (voxelView === 'nodes') {
      applyNodeLabelsToVoxels(scanData, remappedLabelSets.nodes);
    } else if (voxelView === 'leaves') {
      applyNodeLabelsToVoxels(scanData, remappedLabelSets.leaves);
    } else if (voxelView === 'systems') {
      applyNodeLabelsToVoxels(scanData, remappedLabelSets.systems);
    } else {
      applyNodeLabelsToVoxels(scanData, voxelView === 'boundedCaps' ? remappedLabelSets.boundedCaps : remappedLabelSets.boundedSystems);
    }
  }, [applyNodeLabelsToVoxels, remappedLabelSets, result, voxelView]);

  const eventLog = React.useMemo(() => {
    if (!result) return [] as Array<{ layerIndex: number; birth: number; merge: number; split: number; death: number }>;
    const byLayer = new Map<number, { birth: number; merge: number; split: number; death: number }>();
    for (const ev of result.events) {
      if (ev.type === 'continue') continue;
      const row = byLayer.get(ev.layerIndex) ?? { birth: 0, merge: 0, split: 0, death: 0 };
      const c = ev.nodeIds.length;
      if (ev.type === 'birth') row.birth += c;
      else if (ev.type === 'merge') row.merge += c;
      else if (ev.type === 'split') row.split += c;
      else if (ev.type === 'death') row.death += c;
      byLayer.set(ev.layerIndex, row);
    }
    const rows: Array<{ layerIndex: number; birth: number; merge: number; split: number; death: number }> = [];
    for (const [layerIndex, row] of byLayer) {
      rows.push({ layerIndex, ...row });
    }
    rows.sort((a, b) => b.layerIndex - a.layerIndex);
    return rows.slice(0, 60);
  }, [result]);

  return (
    <Card>
      <CardHeader
        left={<h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Island Volumes: Hierarchy Builder</h3>}
        right={(
          <Button
            type="button"
            onClick={() => setResult(null)}
            variant="secondary"
            size="sm"
            className="!h-8 !px-2.5 !py-0 text-[11px]"
          >
            Clear
          </Button>
        )}
      />

      <div className="px-2.5 pt-1 pb-2.5 space-y-2">
      <Button
        type="button"
        disabled={!islands.scanData}
        onClick={() => {
          const scanData = islands.scanData;
          if (!scanData) return;
          const r = buildVolumeHierarchy(scanData, {
            connectivity: islands.connectivity,
            minOverlapPx: islands.minOverlapPx,
            overlapNeighborhoodPx: islands.overlapNeighborhoodPx,
          });
          setResult(r);
          setVoxelView('nodes');
          applyNodeLabelsToVoxels(scanData, r.nodeLabelsPerLayer);
        }}
        variant="primary"
        size="sm"
        className="w-full !h-8 !px-2.5 !py-0 text-[11px] disabled:opacity-50"
      >
        Build Hierarchy
      </Button>

      {result && islands.scanData && (
        <Button
          type="button"
          onClick={() => {
            setVoxelView('nodes');
            applyNodeLabelsToVoxels(islands.scanData!, result.nodeLabelsPerLayer);
          }}
          variant="accent"
          size="sm"
          className="w-full !h-8 !px-2.5 !py-0 text-[11px]"
        >
          Show Nodes In Voxels
        </Button>
      )}

      {result && (
        <div className="grid grid-cols-5 gap-1">
          <button
            type="button"
            onClick={() => {
              const scanData = islands.scanData;
              if (!scanData || !remappedLabelSets) return;
              setVoxelView('nodes');
              applyNodeLabelsToVoxels(scanData, remappedLabelSets.nodes);
            }}
            className={`ui-button !h-8 px-2.5 py-0 text-[11px] ${voxelView === 'nodes' ? 'ui-button-primary' : 'ui-button-secondary'}`}
          >
            Voxels: Nodes
          </button>
          <button
            type="button"
            onClick={() => {
              const scanData = islands.scanData;
              if (!scanData || !remappedLabelSets) return;
              setVoxelView('leaves');
              applyNodeLabelsToVoxels(scanData, remappedLabelSets.leaves);
            }}
            className={`ui-button !h-8 px-2.5 py-0 text-[11px] ${voxelView === 'leaves' ? 'ui-button-primary' : 'ui-button-secondary'}`}
          >
            Voxels: Leaves
          </button>
          <button
            type="button"
            onClick={() => {
              const scanData = islands.scanData;
              if (!scanData || !remappedLabelSets) return;
              setVoxelView('systems');
              applyNodeLabelsToVoxels(scanData, remappedLabelSets.systems);
            }}
            className={`ui-button !h-8 px-2.5 py-0 text-[11px] ${voxelView === 'systems' ? 'ui-button-primary' : 'ui-button-secondary'}`}
          >
            Voxels: Systems
          </button>
          <button
            type="button"
            onClick={() => {
              const scanData = islands.scanData;
              if (!scanData || !remappedLabelSets) return;
              setVoxelView('boundedSystems');
              applyNodeLabelsToVoxels(scanData, remappedLabelSets.boundedSystems);
            }}
            className={`ui-button !h-8 px-2.5 py-0 text-[11px] ${voxelView === 'boundedSystems' ? 'ui-button-primary' : 'ui-button-secondary'}`}
          >
            Voxels: Bounded
          </button>
          <button
            type="button"
            onClick={() => {
              const scanData = islands.scanData;
              if (!scanData || !remappedLabelSets) return;
              setVoxelView('boundedCaps');
              applyNodeLabelsToVoxels(scanData, remappedLabelSets.boundedCaps);
            }}
            className={`ui-button !h-8 px-2.5 py-0 text-[11px] ${voxelView === 'boundedCaps' ? 'ui-button-primary' : 'ui-button-secondary'}`}
          >
            Voxels: Caps
          </button>
        </div>
      )}

      {result && (
        <Button
          type="button"
          onClick={() => setIncludeEventNodes(v => !v)}
          variant="secondary"
          size="sm"
          className="w-full !h-8 !px-2.5 !py-0 text-[11px]"
        >
          {includeEventNodes ? 'Logical Volumes: Show Ownership Leaves Only' : 'Logical Volumes: Include Event Nodes'}
        </Button>
      )}

      {summary && (
        <div className="text-[11px] p-2 rounded space-y-1 border" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
          <div>Nodes: {summary.nodes}</div>
          <div>Edges: {summary.edges}</div>
          <div>Overhang Groups: {summary.groups}</div>
          <div>Leaves: {summary.leaves}</div>
          <div>Merges: {summary.merges}</div>
          <div>Significant Merges: {mergeProminence.significant} (incidental {mergeProminence.incidental})</div>
          <div>Splits: {summary.splits}</div>
          <div>Births: {summary.births}</div>
          <div>Deaths: {summary.deaths}</div>
          <div>Issues: {summary.issues}</div>
        </div>
      )}

      {result && result.issues.length > 0 && (
        <div className="text-[11px] p-2 rounded space-y-1 max-h-28 overflow-auto border" style={{ color: '#fca5a5', borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 55%)', background: 'color-mix(in srgb, var(--danger), transparent 90%)' }}>
          {result.issues.slice(0, 20).map((iss, idx) => (
            <div key={idx}>
              L{iss.layerIndex} Node {iss.nodeId}: {iss.code}
            </div>
          ))}
        </div>
      )}

      {result && eventLog.length > 0 && (
        <div className="text-[11px] p-2 rounded space-y-1 max-h-40 overflow-auto border" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
          {eventLog.map((r) => (
            <div key={r.layerIndex}>
              L{r.layerIndex}: b{r.birth} m{r.merge} s{r.split} d{r.death}
            </div>
          ))}
        </div>
      )}

      {result && logicalVolumes.length > 0 && (
        <div className="text-[11px] p-2 rounded space-y-1 max-h-56 overflow-auto border" style={{ color: 'var(--text-strong)', borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
          <div style={{ color: 'var(--text-muted)' }}>Logical Volumes ({logicalVolumes.length})</div>
          {logicalVolumes.slice(0, 50).map(v => (
            <div key={v.id}>
              Node {v.id}: {v.volumeMm3.toFixed(1)}mm³ | base {v.baseAreaMm2.toFixed(1)}mm² | L{v.firstLayer}-{v.lastLayer}
            </div>
          ))}
        </div>
      )}

      {result && systemVolumes.length > 0 && (
        <div className="text-[11px] p-2 rounded space-y-1 max-h-56 overflow-auto border" style={{ color: 'var(--text-strong)', borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
          <div style={{ color: 'var(--text-muted)' }}>System Volumes (Subtree Unions) ({systemVolumes.length})</div>
          {systemVolumes.slice(0, 30).map(v => (
            <div key={v.rootId}>
              Root {v.rootId}: {v.volumeMm3.toFixed(1)}mm³ | base {v.baseAreaMm2.toFixed(1)}mm² | nodes {v.nodeCount} | L{v.firstLayer}-{v.lastLayer}
            </div>
          ))}
        </div>
      )}

      {result && systemProfiles.length > 0 && (
        <div className="text-[11px] p-2 rounded space-y-1 max-h-56 overflow-auto border" style={{ color: 'var(--text-strong)', borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
          <div style={{ color: 'var(--text-muted)' }}>System Profiles (Merge Nodes Only) ({systemProfiles.length})</div>
          {systemProfiles.slice(0, 30).map(v => (
            <div key={v.rootId}>
              Root {v.rootId}: {v.volumeMm3.toFixed(1)}mm³ | base {v.baseAreaMm2.toFixed(1)}mm² | peak {v.peakAreaMm2.toFixed(1)}mm²@L{v.peakLayer} | h {v.heightMm.toFixed(2)}mm | nodes {v.nodeCount}
            </div>
          ))}
        </div>
      )}

      {result && mergeJunctions.length > 0 && (
        <div className="text-[11px] p-2 rounded space-y-1 max-h-56 overflow-auto border" style={{ color: 'var(--text-strong)', borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
          <div style={{ color: 'var(--text-muted)' }}>Merge Junction Prominence (Top 40)</div>
          {mergeJunctions.slice(0, 40).map((j, idx) => (
            <div key={idx}>
              {j.childId} → {j.parentId} @L{j.mergeLayer}: ratio {j.areaRatio.toFixed(3)} | childPersist {j.childPersistenceMm.toFixed(2)}mm | childEnd {j.childEndAreaMm2.toFixed(1)}mm² | parentStart {j.parentStartAreaMm2.toFixed(1)}mm²
            </div>
          ))}
        </div>
      )}

      {result && cutoffCandidates.bySystem.size > 0 && (
        <div className="text-[11px] p-2 rounded space-y-1 max-h-56 overflow-auto border" style={{ color: 'var(--text-strong)', borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
          <div style={{ color: 'var(--text-muted)' }}>Flat Cutoff Candidates (Incidental Merges, grouped by Bounded System)</div>
          {Array.from(cutoffCandidates.bySystem.entries())
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, 30)
            .map(([systemId, rows]) => (
              <div key={systemId} className="space-y-0.5">
                <div style={{ color: 'var(--text-strong)' }}>System {systemId}: {rows.length} cutoff junction(s)</div>
                {rows.slice(0, 8).map((r, idx) => (
                  <div key={idx} style={{ color: 'var(--text-muted)' }}>
                    {r.childId} → {r.parentId} @L{r.mergeLayer}: ratio {r.areaRatio.toFixed(3)} | childPersist {r.childPersistenceMm.toFixed(2)}mm
                  </div>
                ))}
              </div>
            ))}
        </div>
      )}

      {!islands.scanData && (
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Run an Island Scan first.
        </div>
      )}
      </div>
    </Card>
  );
}
