import type { ScanResults } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import { buildVolumeHierarchy } from '@/volumeAnalysis/IslandVolumes/buildVolumeHierarchy';
import type { BuildVolumeHierarchyResult } from '@/volumeAnalysis/IslandVolumes/types';
import type {
  AutoSupportContactCandidate,
  AutoSupportContactPlan,
  AutoSupportExclusion,
  AutoSupportPlannerSettings,
  UnsupportedVolume,
} from './types';

type Pixel = { x: number; y: number };

function collectNodeStats(
  hierarchy: BuildVolumeHierarchyResult,
): Map<number, { areaPx: number; basePixels: Pixel[] }> {
  const firstLayerById = new Map(hierarchy.nodes.map((node) => [node.id, node.firstLayer]));
  const stats = new Map<number, { areaPx: number; basePixels: Pixel[] }>();

  for (let layer = 0; layer < hierarchy.nodeLabelsPerLayer.length; layer++) {
    const labels = hierarchy.nodeLabelsPerLayer[layer];
    if (!labels) continue;
    for (let y = 0; y < labels.height; y++) {
      const row = labels.rows[y];
      for (let index = 0; index < row.length; index += 3) {
        const start = row[index];
        const length = row[index + 1];
        const nodeId = row[index + 2];
        if (nodeId <= 0) continue;
        let nodeStats = stats.get(nodeId);
        if (!nodeStats) {
          nodeStats = { areaPx: 0, basePixels: [] };
          stats.set(nodeId, nodeStats);
        }
        nodeStats.areaPx += length;
        if (firstLayerById.get(nodeId) !== layer) continue;
        for (let x = start; x < start + length; x++) nodeStats.basePixels.push({ x, y });
      }
    }
  }

  return stats;
}

export function buildUnsupportedVolumes(
  scan: ScanResults,
  layerHeightMm: number,
  hierarchy = buildVolumeHierarchy(scan),
): UnsupportedVolume[] {
  const incomingCount = new Map<number, number>();
  for (const edge of hierarchy.edges) incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
  const stats = collectNodeStats(hierarchy);
  const pixelAreaMm2 = scan.grid.px_mm * scan.grid.px_mm;

  return hierarchy.nodes
    .filter((node) => (incomingCount.get(node.id) ?? 0) === 0)
    .map((node) => {
      const nodeStats = stats.get(node.id) ?? { areaPx: 0, basePixels: [] };
      return {
        id: node.id,
        firstLayer: node.firstLayer,
        lastLayer: node.lastLayer,
        heightMm: (node.lastLayer - node.firstLayer + 1) * layerHeightMm,
        baseAreaMm2: nodeStats.basePixels.length * pixelAreaMm2,
        volumeMm3: nodeStats.areaPx * pixelAreaMm2 * layerHeightMm,
        basePixels: nodeStats.basePixels,
      };
    })
    .sort((left, right) => right.volumeMm3 - left.volumeMm3 || left.id - right.id);
}

function squaredPixelDistance(left: Pixel, right: Pixel): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}

function selectCoveragePixels(pixels: Pixel[], count: number): Pixel[] {
  if (pixels.length === 0 || count <= 0) return [];
  const centroid = pixels.reduce(
    (sum, pixel) => ({ x: sum.x + pixel.x / pixels.length, y: sum.y + pixel.y / pixels.length }),
    { x: 0, y: 0 },
  );
  const first = pixels.reduce((best, pixel) => {
    const bestDistance = squaredPixelDistance(best, centroid);
    const distance = squaredPixelDistance(pixel, centroid);
    return distance < bestDistance || (distance === bestDistance && (pixel.y < best.y || (pixel.y === best.y && pixel.x < best.x)))
      ? pixel
      : best;
  });
  const selected = [first];

  while (selected.length < count && selected.length < pixels.length) {
    let best: Pixel | null = null;
    let bestDistance = -1;
    for (const pixel of pixels) {
      if (selected.some((candidate) => candidate.x === pixel.x && candidate.y === pixel.y)) continue;
      const distance = Math.min(...selected.map((candidate) => squaredPixelDistance(pixel, candidate)));
      if (distance > bestDistance || (distance === bestDistance && best && (pixel.y < best.y || (pixel.y === best.y && pixel.x < best.x)))) {
        best = pixel;
        bestDistance = distance;
      }
    }
    if (!best) break;
    selected.push(best);
  }

  return selected;
}

function pixelToWorld(
  scan: ScanResults,
  scanMinZ: number,
  layerHeightMm: number,
  volume: UnsupportedVolume,
  pixel: Pixel,
): { x: number; y: number; z: number } {
  const maskY = scan.grid.originZ + (pixel.y + 0.5) * scan.grid.px_mm;
  return {
    x: scan.grid.originX + (pixel.x + 0.5) * scan.grid.px_mm,
    y: -maskY,
    z: scanMinZ + (volume.firstLayer + 0.5) * layerHeightMm,
  };
}

function isExcluded(point: { x: number; y: number; z: number }, exclusions: AutoSupportExclusion[]): boolean {
  return exclusions.some((exclusion) => {
    const dx = point.x - exclusion.x;
    const dy = point.y - exclusion.y;
    const dz = point.z - exclusion.z;
    return dx * dx + dy * dy + dz * dz < exclusion.radiusMm * exclusion.radiusMm;
  });
}

export function planAutoSupportContacts(args: {
  scan: ScanResults;
  scanMinZ: number;
  layerHeightMm: number;
  settings: AutoSupportPlannerSettings;
  hierarchy?: BuildVolumeHierarchyResult;
  exclusions?: AutoSupportExclusion[];
  volumeIdFilter?: ReadonlySet<number>;
  contactIdSuffix?: string;
}): AutoSupportContactPlan {
  const { scan, scanMinZ, layerHeightMm, settings, exclusions = [], volumeIdFilter } = args;
  const volumes = buildUnsupportedVolumes(scan, layerHeightMm, args.hierarchy);
  const eligible = volumes.filter((volume) => (
    (!volumeIdFilter || volumeIdFilter.has(volume.id))
    && volume.baseAreaMm2 >= settings.minBaseAreaMm2
    && volume.volumeMm3 >= settings.minVolumeMm3
    && volume.heightMm >= settings.minHeightMm
    && volume.basePixels.length > 0
  ));
  const eligibleIds = new Set(eligible.map((volume) => volume.id));
  const ignoredVolumeIds = volumes
    .filter((volume) => !eligibleIds.has(volume.id) && (!volumeIdFilter || volumeIdFilter.has(volume.id)))
    .map((volume) => volume.id);
  const contacts: AutoSupportContactCandidate[] = [];
  const limitedVolumeIds: number[] = [];
  const coveredVolumeIds: number[] = [];

  for (const volume of eligible) {
    const availablePixels = exclusions.length === 0
      ? volume.basePixels
      : volume.basePixels.filter((pixel) => !isExcluded(pixelToWorld(scan, scanMinZ, layerHeightMm, volume, pixel), exclusions));
    if (availablePixels.length === 0) {
      coveredVolumeIds.push(volume.id);
      continue;
    }
    const desiredCount = Math.max(1, Math.min(
      settings.maxContactsPerVolume,
      Math.ceil(volume.baseAreaMm2 / (settings.contactSpacingMm * settings.contactSpacingMm)),
    ));
    if (contacts.length >= settings.maxTotalContacts) {
      limitedVolumeIds.push(volume.id);
      continue;
    }
    const available = Math.min(desiredCount, settings.maxTotalContacts - contacts.length);
    const pixels = selectCoveragePixels(availablePixels, available);
    for (let index = 0; index < pixels.length; index++) {
      contacts.push({
        id: `${volume.id}:${index}${args.contactIdSuffix ?? ''}`,
        volumeId: volume.id,
        position: pixelToWorld(scan, scanMinZ, layerHeightMm, volume, pixels[index]),
      });
    }
    if (pixels.length < desiredCount) limitedVolumeIds.push(volume.id);
  }

  return { volumes, contacts, ignoredVolumeIds, limitedVolumeIds, coveredVolumeIds };
}
