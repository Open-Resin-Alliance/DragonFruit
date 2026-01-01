import { rleLabelComponents, type RleLabels, type RleMask } from '@/volumeAnalysis/IslandScan/rle';
import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import type {
  BuildVolumeHierarchyOptions,
  BuildVolumeHierarchyResult,
  ValidationIssue,
  VolumeEdge,
  VolumeEvent,
  VolumeNode
} from './types';

type OverlapMap = Map<number, Map<number, number>>;

function addOverlap(m: OverlapMap, fromId: number, toId: number, inc: number) {
  let inner = m.get(fromId);
  if (!inner) {
    inner = new Map();
    m.set(fromId, inner);
  }
  inner.set(toId, (inner.get(toId) ?? 0) + inc);
}

function computeOverlapCounts(
  prev: RleLabels,
  curr: RleLabels,
  neighborhoodPx: number,
): OverlapMap {
  const out: OverlapMap = new Map();
  const height = curr.height;
  const width = curr.width;
  const n = Math.max(0, neighborhoodPx);

  for (let y = 0; y < height; y++) {
    const currRow = curr.rows[y];
    if (currRow.length === 0) continue;

    const yStart = Math.max(0, y - n);
    const yEnd = Math.min(height - 1, y + n);

    for (let py = yStart; py <= yEnd; py++) {
      const prevRow = prev.rows[py];
      if (prevRow.length === 0) continue;

      let i = 0;
      let j = 0;

      while (i < prevRow.length && j < currRow.length) {
        const pStartRaw = prevRow[i];
        const pLen = prevRow[i + 1];
        const pId = prevRow[i + 2];
        const pEndRaw = pStartRaw + pLen;

        const pStart = Math.max(0, pStartRaw - n);
        const pEnd = Math.min(width, pEndRaw + n);

        const cStart = currRow[j];
        const cLen = currRow[j + 1];
        const cId = currRow[j + 2];
        const cEnd = cStart + cLen;

        const oStart = Math.max(pStart, cStart);
        const oEnd = Math.min(pEnd, cEnd);

        if (oStart < oEnd && pId > 0 && cId > 0) {
          addOverlap(out, pId, cId, oEnd - oStart);
        }

        if (pEnd <= cEnd) i += 3;
        else j += 3;
      }
    }
  }

  return out;
}

export function buildVolumeHierarchy(
  scan: ScanResults,
  options?: BuildVolumeHierarchyOptions,
): BuildVolumeHierarchyResult {
  const connectivity = options?.connectivity ?? 8;
  const minOverlapPx = Math.max(1, options?.minOverlapPx ?? 4);
  const overlapNeighborhoodPx = Math.max(0, options?.overlapNeighborhoodPx ?? 1);

  const nodes: VolumeNode[] = [];
  const nodesById = new Map<number, VolumeNode>();
  const edges: VolumeEdge[] = [];
  const edgeKey = new Set<string>();

  const events: VolumeEvent[] = [];
  const issues: ValidationIssue[] = [];
  const nodeLabelsPerLayer: RleLabels[] = new Array(scan.layers.length);

  const layers = scan.layers;
  const numLayers = layers.length;

  let nextNodeId = 1;

  let prevComponentToNode = new Map<number, number>();
  let prevLabels: RleLabels | null = null;

  const nodeLastSeenLayer = new Map<number, number>();

  for (let layerIndex = 0; layerIndex < numLayers; layerIndex++) {
    const solidMask: RleMask = layers[layerIndex].islandMaskRle;
    const { labels: currLabels, components: currComps } = rleLabelComponents(solidMask, connectivity);

    const currComponentToNode = new Map<number, number>();
    const nodesUsedThisLayer = new Map<number, number>();

    const birthNodeIds: number[] = [];
    const continueNodeIds: number[] = [];
    const mergeNodeIds: number[] = [];

    let incoming: Map<number, Set<number>> = new Map();
    let outgoing: Map<number, Set<number>> = new Map();

    if (prevLabels) {
      const overlap = computeOverlapCounts(prevLabels, currLabels, overlapNeighborhoodPx);

      for (const [pId, toMap] of overlap) {
        for (const [cId, count] of toMap) {
          if (count < minOverlapPx) continue;

          let inSet = incoming.get(cId);
          if (!inSet) {
            inSet = new Set();
            incoming.set(cId, inSet);
          }
          inSet.add(pId);

          let outSet = outgoing.get(pId);
          if (!outSet) {
            outSet = new Set();
            outgoing.set(pId, outSet);
          }
          outSet.add(cId);
        }
      }
    }

    if (prevLabels) {
      const splitParents = new Set<number>();
      const deaths = new Set<number>();

      for (const [pId, outSet] of outgoing) {
        if (outSet.size > 1) {
          const parentNodeId = prevComponentToNode.get(pId);
          if (parentNodeId) splitParents.add(parentNodeId);
        }
      }

      for (const prevCompId of prevComponentToNode.keys()) {
        if (!outgoing.has(prevCompId) || outgoing.get(prevCompId)!.size === 0) {
          const nodeId = prevComponentToNode.get(prevCompId);
          if (nodeId) deaths.add(nodeId);
        }
      }

      if (splitParents.size > 0) {
        events.push({ layerIndex, type: 'split', nodeIds: Array.from(splitParents) });
      }
      if (deaths.size > 0) {
        events.push({ layerIndex, type: 'death', nodeIds: Array.from(deaths) });
      }
    }

    for (const comp of currComps) {
      const compId = comp.id;
      let nodeId = 0;

      let reusedFromPrev = false;
      let prevCompIdForReuse: number | null = null;

      const incomingSet = prevLabels ? incoming.get(compId) : undefined;
      const incomingCount = incomingSet ? incomingSet.size : 0;
      const isMerge = prevLabels ? incomingCount > 1 : false;
      const isBirth = !prevLabels || incomingCount === 0;

      if (prevLabels) {
        if (incomingSet && incomingSet.size === 1) {
          const prevCompId = incomingSet.values().next().value as number;
          const outSet = outgoing.get(prevCompId);
          if (outSet && outSet.size === 1 && outSet.has(compId)) {
            const prevNodeId = prevComponentToNode.get(prevCompId);
            if (prevNodeId) {
              nodeId = prevNodeId;
              reusedFromPrev = true;
              prevCompIdForReuse = prevCompId;
            }
          }
        }
      }

      if (!nodeId) {
        nodeId = nextNodeId++;
        const node: VolumeNode = { id: nodeId, firstLayer: layerIndex, lastLayer: layerIndex };
        nodes.push(node);
        nodesById.set(nodeId, node);
      } else {
        const n = nodesById.get(nodeId);
        if (n) n.lastLayer = layerIndex;
      }

      currComponentToNode.set(compId, nodeId);

      nodesUsedThisLayer.set(nodeId, (nodesUsedThisLayer.get(nodeId) ?? 0) + 1);

      const lastSeen = nodeLastSeenLayer.get(nodeId);
      if (lastSeen !== undefined && lastSeen !== layerIndex - 1) {
        issues.push({
          layerIndex,
          code: 'node_non_contiguous',
          nodeId,
          details: `Last seen at layer ${lastSeen}`
        });
      }
      nodeLastSeenLayer.set(nodeId, layerIndex);

      if (nodeId && prevLabels) {
        if (reusedFromPrev) {
          const prevOutCount = prevCompIdForReuse ? (outgoing.get(prevCompIdForReuse)?.size ?? 0) : 0;
          if (incomingCount !== 1 || prevOutCount !== 1) {
            issues.push({
              layerIndex,
              code: 'continued_through_event',
              nodeId,
              details: `incoming=${incomingCount}, prevOutgoing=${prevOutCount}`
            });
          }
          if (isMerge) {
            issues.push({
              layerIndex,
              code: 'continued_through_event',
              nodeId,
              details: 'Continuation on merge layer'
            });
          }
        } else if (!isBirth && incomingCount === 1) {
          const prevCompId = incomingSet ? (incomingSet.values().next().value as number) : 0;
          const prevNodeId = prevComponentToNode.get(prevCompId);
          const prevOutCount = prevCompId ? (outgoing.get(prevCompId)?.size ?? 0) : 0;
          if (prevNodeId && prevOutCount === 1) {
            issues.push({
              layerIndex,
              code: 'continued_through_event',
              nodeId,
              details: `Should have continued node ${prevNodeId} (incoming=1, prevOutgoing=1)`
            });
          }
        }
      }

      if (isBirth) {
        birthNodeIds.push(nodeId);
      } else if (reusedFromPrev) {
        continueNodeIds.push(nodeId);
      }

      if (isMerge) {
        mergeNodeIds.push(nodeId);
      }
    }

    const nodeLabelRows: Int32Array[] = new Array(currLabels.height);
    for (let y = 0; y < currLabels.height; y++) {
      const row = currLabels.rows[y];
      if (row.length === 0) {
        nodeLabelRows[y] = new Int32Array(0);
        continue;
      }
      const out: number[] = [];
      for (let i = 0; i < row.length; i += 3) {
        const start = row[i];
        const len = row[i + 1];
        const compId = row[i + 2];
        const nodeId = currComponentToNode.get(compId) ?? 0;
        if (nodeId > 0) {
          out.push(start, len, nodeId);
        }
      }
      nodeLabelRows[y] = new Int32Array(out);
    }
    nodeLabelsPerLayer[layerIndex] = { rows: nodeLabelRows, width: currLabels.width, height: currLabels.height };

    if (birthNodeIds.length > 0) {
      events.push({ layerIndex, type: 'birth', nodeIds: birthNodeIds });
    }
    if (continueNodeIds.length > 0) {
      events.push({ layerIndex, type: 'continue', nodeIds: continueNodeIds });
    }
    if (mergeNodeIds.length > 0) {
      events.push({ layerIndex, type: 'merge', nodeIds: mergeNodeIds });
    }

    for (const [nodeId, count] of nodesUsedThisLayer) {
      if (count > 1) {
        issues.push({
          layerIndex,
          code: 'node_multiple_components_same_layer',
          nodeId,
          details: `Assigned to ${count} components`
        });
      }
    }

    if (prevLabels) {
      for (const [cId, inSet] of incoming) {
        if (inSet.size <= 1) continue;

        const parentNodeId = currComponentToNode.get(cId);
        if (!parentNodeId) continue;

        for (const pId of inSet) {
          const childNodeId = prevComponentToNode.get(pId);
          if (!childNodeId) continue;
          if (childNodeId === parentNodeId) continue;

          const k = `${childNodeId}->${parentNodeId}:merge`;
          if (edgeKey.has(k)) continue;
          edgeKey.add(k);
          edges.push({ from: childNodeId, to: parentNodeId, type: 'merge' });
        }
      }

      for (const [pId, outSet] of outgoing) {
        if (outSet.size <= 1) continue;

        const parentNodeId = prevComponentToNode.get(pId);
        if (!parentNodeId) continue;

        for (const cId of outSet) {
          const childNodeId = currComponentToNode.get(cId);
          if (!childNodeId) continue;
          if (childNodeId === parentNodeId) continue;

          const k = `${parentNodeId}->${childNodeId}:split`;
          if (edgeKey.has(k)) continue;
          edgeKey.add(k);
          edges.push({ from: parentNodeId, to: childNodeId, type: 'split' });
        }
      }
    }

    prevLabels = currLabels;
    prevComponentToNode = currComponentToNode;
  }

  return { nodes, edges, events, issues, nodeLabelsPerLayer };
}
