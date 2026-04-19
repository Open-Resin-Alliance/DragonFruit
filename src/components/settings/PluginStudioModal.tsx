'use client';

import React from 'react';
import { AlertTriangle, Archive, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, FileText, FlaskConical, GitBranch, Layers, Maximize2, Minimize2, Plus, Printer, Search, Square, Trash2, X } from 'lucide-react';
import JSZip from 'jszip';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';
import { writeBytesToNativePath } from '@/features/slicing/tauri/nativeSlicerBridge';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import {
  getProfileLocalMaterialSettingsAdapter,
  getAvailableProfileNetworkModes,
} from '@/features/plugins/pluginRegistry';
import {
  getAvailableOutputFormatOptions,
  getAvailableFormatVersionOptions,
  getAvailableSettingsModeOptions,
} from '@/features/slicing/formats/registry';
import {
  getAvailablePrinterPresets,
  getInstalledPlugins,
  getProfileStoreServerSnapshot,
  getProfileStoreSnapshot,
  subscribeToProfileStore,
} from '@/features/profiles/profileStore';
import type { LocalMaterialSettingsMap, LocalMaterialSettingsValue } from '@/features/profiles/profileStore';
import {
  type MaterialDraft,
  type LocalSettingsByOutputDraft,
  LabeledInput,
  LabeledNumberInput,
  LabeledToggleInput,
  MaterialProfileIdentitySection,
  MaterialProfileFormSections,
  PluginLocalMaterialSettingsSections,
} from './profileFormAtoms';

// ─── Types ────────────────────────────────────────────────────────────────────

type PluginMeta = {
  name: string;
  slug: string;
  version: string;
  author: string;
  githubOwner: string;
  description: string;
  homepage: string;
};

type PrinterPresetDraft = {
  presetId: string;
  manufacturer: string;
  family: string;
  name: string;
  imageAssetPath: string;
  outputFormat: string;
  formatVersion: string;
  settingsMode: string;
  networkSupport: string;
  networkFilter: string;
  hasCamera: boolean;
  webcamRotationDeg: 0 | 90 | 180 | 270;
  resolutionX: number;
  resolutionY: number;
  bitDepth: number;
  mirrorX: boolean;
  mirrorY: boolean;
  autoBuildWidthDepth: boolean;
  buildWidth: number;
  buildDepth: number;
  buildHeight: number;
  frontMargin: number;
  backMargin: number;
  leftMargin: number;
  rightMargin: number;
  pixelSizeX: number;
  pixelSizeY: number;
  antiAliasing: boolean;
};

type MaterialTemplateDraft = {
  draft: MaterialDraft;
  localSettingsByOutput: LocalSettingsByOutputDraft;
  targetPresetId: string;
};

type StepId = 'details' | 'repo' | 'content' | 'printers' | 'assets' | 'materials' | 'export';
type StepTone = 'primary' | 'secondary';
type ImportManifestResult = { ok: true; message: string } | { ok: false; message: string };
type PresetTargetOption = {
  presetId: string;
  label: string;
  description: string;
  manufacturer: string;
  outputFormat: string;
  settingsMode: string;
};

type UploadedPrinterAsset = {
  file: File;
  previewUrl: string;
};

type PrinterAssetExportFile = {
  relativePath: string;
  file: File;
};

type AssetPreviewContext = {
  pluginId?: string;
  pluginSlug?: string;
  sourceUrl?: string;
  homepage?: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_STEP_IDS: StepId[] = ['details', 'content', 'printers', 'assets', 'materials', 'export', 'repo'];

const STEP_LABELS: Record<StepId, string> = {
  details: 'Plugin Details',
  repo: 'Repository',
  content: 'Content',
  printers: 'Printers',
  assets: 'Assets',
  materials: 'Materials',
  export: 'Export',
};

const STEP_META: Record<StepId, {
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  tone: StepTone;
}> = {
  details: {
    label: 'Plugin Details',
    description: 'Name, slug, version, author, and GitHub owner',
    icon: FileText,
    tone: 'primary',
  },
  repo: {
    label: 'Repository',
    description: 'Publish and install your plugin',
    icon: GitBranch,
    tone: 'primary',
  },
  content: {
    label: 'Content',
    description: 'Choose printers and/or materials',
    icon: Layers,
    tone: 'primary',
  },
  printers: {
    label: 'Printer Presets',
    description: 'Define contributed printer models',
    icon: Printer,
    tone: 'primary',
  },
  assets: {
    label: 'Assets',
    description: 'Upload printer images by family folder',
    icon: Archive,
    tone: 'primary',
  },
  materials: {
    label: 'Material Presets',
    description: 'Define printer-scoped material profiles',
    icon: FlaskConical,
    tone: 'primary',
  },
  export: {
    label: 'Export',
    description: 'Preview, copy, and save plugin files',
    icon: Archive,
    tone: 'secondary',
  },
};

const OUTPUT_FORMAT_OPTIONS = getAvailableOutputFormatOptions();
const WEBCAM_ROTATION_OPTIONS: Array<{ value: `${0 | 90 | 180 | 270}`; label: string }> = [
  { value: '0', label: '0°' },
  { value: '90', label: '90°' },
  { value: '180', label: '180°' },
  { value: '270', label: '270°' },
];

const DEFAULT_PRINTER_PRESET: PrinterPresetDraft = {
  presetId: '',
  manufacturer: '',
  family: '',
  name: '',
  imageAssetPath: '',
  outputFormat: '',
  formatVersion: '',
  settingsMode: '',
  networkSupport: '',
  networkFilter: '',
  hasCamera: true,
  webcamRotationDeg: 0,
  resolutionX: 0,
  resolutionY: 0,
  bitDepth: 8,
  mirrorX: false,
  mirrorY: false,
  autoBuildWidthDepth: false,
  buildWidth: 0,
  buildDepth: 0,
  buildHeight: 0,
  frontMargin: 0,
  backMargin: 0,
  leftMargin: 0,
  rightMargin: 0,
  pixelSizeX: 0,
  pixelSizeY: 0,
  antiAliasing: false,
};

const DEFAULT_MATERIAL_DRAFT: MaterialDraft = {
  name: '',
  brand: '',
  currencyCode: 'USD',
  bottlePrice: 0,
  bottleCapacityMl: 1000,
  resinFamily: 'standard',
  scaleCompensationPct: { x: 0, y: 0, z: 0 },
  layerHeightMm: 0.05,
  normalExposureSec: 2.5,
  bottomExposureSec: 28,
  bottomLayerCount: 5,
  liftDistanceMm: 6,
  liftSpeedMmMin: 60,
  retractSpeedMmMin: 150,
  minimumAaAlphaPercent: 35,
};

const ACCENT_SECONDARY_BUTTON_STYLE_92: React.CSSProperties = {
  color: 'var(--accent-secondary-action-color)',
  borderColor: 'var(--accent-secondary-action-border)',
  background: 'var(--accent-secondary-action-bg-92)',
};

const ACCENT_SECONDARY_BUTTON_STYLE_90: React.CSSProperties = {
  color: 'var(--accent-secondary-action-color)',
  borderColor: 'var(--accent-secondary-action-border)',
  background: 'var(--accent-secondary-action-bg-90)',
};

function normalizeOutputFormatKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  return normalized.startsWith('.') ? normalized : `.${normalized}`;
}

function buildTargetOptionsFromAvailablePresets(): PresetTargetOption[] {
  return getAvailablePrinterPresets()
    .map((preset) => ({
      presetId: preset.presetId,
      label: `${preset.manufacturer} ${preset.name}`.trim(),
      description: preset.family?.trim() || 'No family',
      manufacturer: preset.manufacturer?.trim() || 'Unknown',
      outputFormat: normalizeOutputFormatKey(preset.display.outputFormat),
      settingsMode: preset.display.settingsMode?.trim().toLowerCase() || '',
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function createDefaultMaterialTemplateDraft(targetPresetId = ''): MaterialTemplateDraft {
  return {
    draft: { ...DEFAULT_MATERIAL_DRAFT },
    localSettingsByOutput: {},
    targetPresetId,
  };
}

// ─── JSON builders ────────────────────────────────────────────────────────────

function printerPresetDraftToJson(d: PrinterPresetDraft): Record<string, unknown> {
  const preset: Record<string, unknown> = {
    presetId: d.presetId,
    manufacturer: d.manufacturer,
    name: d.name,
    buildVolumeMm: {
      width: d.autoBuildWidthDepth ? null : d.buildWidth,
      depth: d.autoBuildWidthDepth ? null : d.buildDepth,
      height: d.buildHeight,
    },
    display: {
      resolutionX: d.resolutionX,
      resolutionY: d.resolutionY,
      outputFormat: d.outputFormat || '.ctb',
      ...(d.formatVersion ? { formatVersion: d.formatVersion } : {}),
      ...(d.settingsMode ? { settingsMode: d.settingsMode } : {}),
      ...(d.hasCamera ? { webcamRotationDeg: d.webcamRotationDeg } : {}),
      mirrorX: d.mirrorX,
      mirrorY: d.mirrorY,
    },
    hasCamera: d.hasCamera,
  };

  if (d.bitDepth > 0) preset['bitDepth'] = { bits: d.bitDepth };
  if (d.family.trim()) preset['family'] = d.family.trim();
  if (d.imageAssetPath.trim()) preset['imageAssetPath'] = d.imageAssetPath.trim();
  if (d.pixelSizeX > 0 && d.pixelSizeY > 0) preset['pixelSize'] = { x: d.pixelSizeX, y: d.pixelSizeY };
  if (d.frontMargin > 0 || d.backMargin > 0 || d.leftMargin > 0 || d.rightMargin > 0) {
    preset['safetyMarginMm'] = {
      front: d.frontMargin,
      back: d.backMargin,
      left: d.leftMargin,
      right: d.rightMargin,
    };
  }
  if (d.networkSupport.trim()) preset['networkSupport'] = d.networkSupport.trim().toLowerCase();
  if (d.networkFilter.trim()) preset['networkFilter'] = d.networkFilter.trim();
  if (d.antiAliasing) preset['antiAliasing'] = true;
  return preset;
}

type PrinterPresetSplitFile = {
  relativePath: string;
  content: string;
};

type MaterialPresetSplitFile = {
  relativePath: string;
  content: string;
};

function buildPrinterPresetSplitFiles(printerPresets: PrinterPresetDraft[]): PrinterPresetSplitFile[] {
  if (printerPresets.length === 0) return [];

  const grouped = new Map<string, PrinterPresetDraft[]>();
  printerPresets.forEach((preset) => {
    const family = preset.family.trim() || preset.manufacturer.trim() || 'ungrouped';
    if (!grouped.has(family)) grouped.set(family, []);
    grouped.get(family)?.push(preset);
  });

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, members]) => {
      const relativePath = `printers/${slugifyPathSegment(family)}-series.json`;
      const orderedMembers = [...members].sort((a, b) => {
        const aLabel = `${a.manufacturer} ${a.name}`.trim();
        const bLabel = `${b.manufacturer} ${b.name}`.trim();
        return aLabel.localeCompare(bLabel);
      });
      return {
        relativePath,
        content: JSON.stringify(orderedMembers.map(printerPresetDraftToJson), null, 2),
      };
    });
}

function deriveMaterialPresetFileStem(targetPresetId: string, target: PresetTargetOption | undefined): string {
  const manufacturerSlug = slugifyPathSegment(target?.manufacturer || 'unassigned');
  let stem = targetPresetId.trim().toLowerCase();

  if (manufacturerSlug && stem.startsWith(`${manufacturerSlug}-`)) {
    stem = stem.slice(manufacturerSlug.length + 1);
  }

  const outputFormatSlug = slugifyPathSegment((target?.outputFormat || '').replace(/^\./, ''));
  if (outputFormatSlug && stem.endsWith(`-${outputFormatSlug}`)) {
    stem = stem.slice(0, -(`-${outputFormatSlug}`.length));
  }

  const fallback = target?.label || targetPresetId || 'unassigned';
  return slugifyPathSegment(stem || fallback);
}

function materialTemplateDraftToJson(
  d: MaterialTemplateDraft,
  targetOptionById?: Map<string, PresetTargetOption>,
): Record<string, unknown> {
  const { localSettingsByOutput: _local, ...rest } = d.draft as Record<string, unknown>;
  const template: Record<string, unknown> = { ...rest };
  const selectedPresetId = d.targetPresetId.trim();

  if (selectedPresetId) {
    template['validForPresets'] = [selectedPresetId];

    const matchingPreset = targetOptionById?.get(selectedPresetId)
      ?? buildTargetOptionsFromAvailablePresets().find((preset) => preset.presetId === selectedPresetId);
    const resolvedFormat = matchingPreset?.outputFormat ?? '';
    if (resolvedFormat) {
      const localSettings = d.localSettingsByOutput[resolvedFormat] ?? {};
      if (Object.keys(localSettings).length > 0) {
        template['localSettingsByOutput'] = { [resolvedFormat]: localSettings };
      }
    }
  } else {
    const fallbackFormat = Object.keys(d.localSettingsByOutput)[0];
    if (fallbackFormat) {
      const localSettings = d.localSettingsByOutput[fallbackFormat] ?? {};
      if (Object.keys(localSettings).length > 0) {
        template['localSettingsByOutput'] = { [fallbackFormat]: localSettings };
      }
    }
  }

  return template;
}

function buildMaterialPresetSplitFiles(
  materialTemplates: MaterialTemplateDraft[],
  targetOptionById: Map<string, PresetTargetOption>,
): MaterialPresetSplitFile[] {
  if (materialTemplates.length === 0) return [];

  const grouped = new Map<string, MaterialTemplateDraft[]>();

  materialTemplates.forEach((template) => {
    const selectedPresetId = template.targetPresetId.trim();
    if (!selectedPresetId) return;

    const target = targetOptionById.get(selectedPresetId);
    const manufacturerSegment = slugifyPathSegment(target?.manufacturer || 'unassigned');
    const fileStem = deriveMaterialPresetFileStem(selectedPresetId, target);
    const relativePath = `materials/${manufacturerSegment}/${fileStem}.json`;

    if (!grouped.has(relativePath)) grouped.set(relativePath, []);
    grouped.get(relativePath)?.push(template);
  });

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relativePath, members]) => {
      const orderedMembers = [...members].sort((a, b) => {
        const aLabel = `${a.draft.brand} ${a.draft.name}`.trim() || 'Material';
        const bLabel = `${b.draft.brand} ${b.draft.name}`.trim() || 'Material';
        return aLabel.localeCompare(bLabel);
      });

      return {
        relativePath,
        content: JSON.stringify(orderedMembers.map((template) => materialTemplateDraftToJson(template, targetOptionById)), null, 2),
      };
    });
}

function buildPluginJson(
  meta: PluginMeta,
  includesPrinters: boolean,
  includesMaterials: boolean,
  printerPresets: PrinterPresetDraft[],
  materialPresetFiles: MaterialPresetSplitFile[],
): string {
  const normalizedSlug = meta.slug.trim() || 'my-plugin';
  const manifestId = normalizedSlug.startsWith('df-plugin-')
    ? normalizedSlug.slice('df-plugin-'.length)
    : normalizedSlug;

  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    id: manifestId,
    name: meta.name || 'My Plugin',
    version: meta.version || '1.0.0',
  };
  if (meta.description.trim()) manifest['description'] = meta.description.trim();
  if (meta.author.trim()) manifest['author'] = meta.author.trim();
  if (meta.homepage.trim()) manifest['homepage'] = meta.homepage.trim();
  if (includesPrinters && printerPresets.length > 0) {
    const splitFiles = buildPrinterPresetSplitFiles(printerPresets);
    manifest['printerPresetPaths'] = splitFiles.map((file) => file.relativePath);
  }
  if (includesMaterials && materialPresetFiles.length > 0) {
    manifest['materialPresetPaths'] = materialPresetFiles.map((file) => file.relativePath);
  }
  return JSON.stringify(manifest, null, 2);
}

function normalizeGithubOwner(value: string): string {
  return value.trim().replace(/^@+/, '').replace(/^\/+|\/+$/g, '');
}

function isValidGithubOwner(value: string): boolean {
  const owner = normalizeGithubOwner(value);
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner);
}

function parseGithubRepoUrl(value: string): { owner: string; repo: string } | null {
  const input = value.trim();
  if (!input) return null;

  try {
    const parsed = new URL(input);
    if (!/^github\.com$/i.test(parsed.hostname)) return null;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;

    const owner = normalizeGithubOwner(segments[0]);
    const repo = segments[1].replace(/\.git$/i, '');
    if (!owner || !repo) return null;

    return { owner, repo };
  } catch {
    return null;
  }
}

function parseGithubOwnerRepoFromAnyUrl(value: string): { owner: string; repo: string } | null {
  const input = value.trim();
  if (!input) return null;

  try {
    const parsed = new URL(input);
    const host = parsed.hostname.toLowerCase();

    if (host === 'github.com') {
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (segments.length >= 2) {
        return {
          owner: normalizeGithubOwner(segments[0]),
          repo: segments[1].replace(/\.git$/i, ''),
        };
      }
    }

    if (host === 'raw.githubusercontent.com') {
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (segments.length >= 2) {
        return {
          owner: normalizeGithubOwner(segments[0]),
          repo: segments[1].replace(/\.git$/i, ''),
        };
      }
    }

    if (host === 'api.github.com') {
      const segments = parsed.pathname.split('/').filter(Boolean);
      const reposIdx = segments.findIndex((segment) => segment === 'repos');
      if (reposIdx >= 0 && segments.length >= reposIdx + 3) {
        return {
          owner: normalizeGithubOwner(segments[reposIdx + 1]),
          repo: segments[reposIdx + 2].replace(/\.git$/i, ''),
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

function isValidHttpUrl(value: string): boolean {
  const input = value.trim();
  if (!input) return false;

  try {
    const parsed = new URL(input);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getIncompletePluginDetailFields(
  meta: PluginMeta,
  options: { allowMissingAttribution?: boolean } = {},
): string[] {
  const { allowMissingAttribution = false } = options;
  const incomplete: string[] = [];

  if (!meta.name.trim()) incomplete.push('Display Name');
  if (!meta.slug.trim()) incomplete.push('Slug');
  if (!meta.version.trim()) incomplete.push('Version');
  if (!allowMissingAttribution && !meta.author.trim()) incomplete.push('Author');
  if (!meta.description.trim()) incomplete.push('Description');

  if (!allowMissingAttribution) {
    if (!meta.githubOwner.trim()) {
      incomplete.push('GitHub Owner');
    } else if (!isValidGithubOwner(meta.githubOwner)) {
      incomplete.push('GitHub Owner (invalid format)');
    }
  } else if (meta.githubOwner.trim() && !isValidGithubOwner(meta.githubOwner)) {
    incomplete.push('GitHub Owner (invalid format)');
  }

  if (!allowMissingAttribution) {
    if (!meta.homepage.trim()) {
      incomplete.push('Repository URL');
    } else if (!isValidHttpUrl(meta.homepage)) {
      incomplete.push('Repository URL (must start with http:// or https://)');
    }
  } else if (meta.homepage.trim() && !isValidHttpUrl(meta.homepage)) {
    incomplete.push('Repository URL (must start with http:// or https://)');
  }

  return incomplete;
}

function buildReadmeTemplate(meta: PluginMeta): string {
  const slug = meta.slug || 'my-plugin';
  const repoName = `df-plugin-${slug}`;
  const parsedHomepageRepo = parseGithubRepoUrl(meta.homepage);
  const homepageOwner = parsedHomepageRepo?.owner ?? null;
  const explicitOwner = normalizeGithubOwner(meta.githubOwner);
  const resolvedOwner = explicitOwner || homepageOwner || '';
  const hasValidOwner = isValidGithubOwner(resolvedOwner);
  const hasHomepageRepoUrl = parsedHomepageRepo !== null;
  const repoUrl = hasHomepageRepoUrl
    ? meta.homepage.trim()
    : hasValidOwner
      ? `https://github.com/${resolvedOwner}/${repoName}`
      : '<set-valid-github-owner-or-repo-url>';
  const submoduleCmd = `git submodule add ${repoUrl} plugins/${slug}`;

  return [
    `# ${repoName}`,
    '',
    meta.description || `${meta.name || 'Plugin'} presets for DragonFruit.`,
    '',
    '## Installation',
    '',
    '### Via DragonFruit Plugin Manager',
    '',
    'Open **Settings → Plugins → Install from GitHub URL** and paste:',
    '',
    '```',
    repoUrl,
    '```',
    '',
    '### Git Submodule',
    '',
    '```bash',
    submoduleCmd,
    '```',
  ].join('\n');
}

function buildReadmeFetchCandidates(options: { homepage?: string; sourceUrl?: string; pluginId?: string }): string[] {
  const candidates: string[] = [];
  const add = (value: string) => {
    if (!value) return;
    if (!candidates.includes(value)) candidates.push(value);
  };

  const addLocalPluginReadmeCandidates = (folderName: string) => {
    const safe = folderName.trim();
    if (!safe) return;
    add(`/api/profile-assets/plugins/${safe}/README.md`);
    add(`/plugins/${safe}/README.md`);
  };

  const addGithubRepoCandidates = (repoUrl: string) => {
    const parsed = parseGithubRepoUrl(repoUrl);
    if (!parsed) return;

    add(`https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/main/README.md`);
    add(`https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/master/README.md`);

    if (parsed.repo.startsWith('df-plugin-')) {
      const localFolder = parsed.repo.slice('df-plugin-'.length);
      addLocalPluginReadmeCandidates(localFolder);
    }
  };

  if (options.pluginId) {
    const slugFromId = parseSlugFromPluginId(options.pluginId);
    const parts = slugFromId.split('-').filter(Boolean);
    if (parts.length > 0) addLocalPluginReadmeCandidates(parts[0]);
    addLocalPluginReadmeCandidates(slugFromId);
  }

  if (options.sourceUrl) addGithubRepoCandidates(options.sourceUrl);
  if (options.homepage) addGithubRepoCandidates(options.homepage);

  return candidates;
}

async function tryLoadExistingReadme(options: { homepage?: string; sourceUrl?: string; pluginId?: string }): Promise<string | null> {
  const candidates = buildReadmeFetchCandidates(options);
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { cache: 'no-store' });
      if (!response.ok) continue;
      const text = await response.text();
      if (text.trim().length === 0) continue;
      return text;
    } catch {
      // no-op: continue trying other candidates
    }
  }
  return null;
}

function isSimplePluginManifestLike(manifest: Record<string, unknown>): boolean {
  const printerPresets = Array.isArray(manifest.printerPresets) ? manifest.printerPresets : [];
  const materialPresets = Array.isArray(manifest.materialPresets) ? manifest.materialPresets : [];
  const materialTemplates = Array.isArray(manifest.materialTemplates) ? manifest.materialTemplates : [];
  return printerPresets.length > 0 || materialPresets.length > 0 || materialTemplates.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeWebcamRotation(value: unknown, fallback: 0 | 90 | 180 | 270 = 0): 0 | 90 | 180 | 270 {
  const parsed = Number(value);
  if (parsed === 0 || parsed === 90 || parsed === 180 || parsed === 270) {
    return parsed;
  }
  return fallback;
}

function computeBuildDimensionMm(resolutionPx: number, pixelSizeUm: number): number {
  const safeResolution = Math.max(1, Math.round(resolutionPx));
  const safePixel = Math.max(0.001, Number(pixelSizeUm) || 0.001);
  return Number(((safeResolution * safePixel) / 1000).toFixed(3));
}

function parseSlugFromPluginId(id: string): string {
  const normalized = id.trim();
  if (!normalized) return '';
  return normalized.startsWith('df-plugin-') ? normalized.slice('df-plugin-'.length) : normalized;
}

function slugifyPathSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'printer';
}

function buildSuggestedPrinterAssetPath(preset: PrinterPresetDraft): string {
  const familyOrMaker = preset.family.trim() || preset.manufacturer.trim() || 'printers';
  const model = preset.name.trim() || preset.presetId.trim() || 'printer';
  return `./assets/${slugifyPathSegment(familyOrMaker)}/${slugifyPathSegment(model)}.png`;
}

function getPresetAssetUploadKey(preset: PrinterPresetDraft, index: number): string {
  const id = preset.presetId.trim();
  if (id) return `preset:${id}`;
  const fallback = [preset.manufacturer, preset.family, preset.name]
    .map((part) => slugifyPathSegment(part))
    .filter(Boolean)
    .join('-');
  return `draft:${fallback || 'printer'}:${index}`;
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body?.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function normalizeAssetRelativePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return normalized;
}

function normalizePluginDirectorySlug(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'my-plugin';
  return trimmed.startsWith('df-plugin-') ? trimmed.slice('df-plugin-'.length) : trimmed;
}

function toPluginAssetFileRelativePath(assetPath: string): string {
  const normalized = normalizeAssetRelativePath(assetPath).replace(/^printers\//i, '');
  return normalized.startsWith('assets/') ? `printers/${normalized}` : `printers/assets/${normalized}`;
}

function shouldUseBundledAssetPathsForPreview(): boolean {
  if (typeof window === 'undefined') return false;
  if (process.env.NODE_ENV !== 'production') return false;
  const protocol = window.location?.protocol ?? '';
  const hostname = window.location?.hostname ?? '';
  const hasTauriInternals = typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
  return protocol === 'file:' || protocol === 'tauri:' || hostname === 'tauri.localhost' || hasTauriInternals;
}

function toRuntimeAssetPath(path: string): string {
  const isBundledRuntime = shouldUseBundledAssetPathsForPreview();
  if (path.startsWith('/api/profile-assets/')) {
    if (!isBundledRuntime) return path;
    return `/${path.slice('/api/profile-assets/'.length)}`;
  }
  if (path.startsWith('/plugins/') || path.startsWith('/printers/')) {
    if (isBundledRuntime) return path;
    return `/api/profile-assets${path}`;
  }
  return path;
}

function normalizeImportedImageAssetPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return '';

  // Runtime-resolved profile asset path:
  // /api/profile-assets/plugins/<plugin>/printers/assets/<...>
  const runtimeMatch = trimmed.match(/^\/api\/profile-assets\/plugins\/[^/]+\/printers\/(assets\/.+)$/i);
  if (runtimeMatch?.[1]) {
    return `./${runtimeMatch[1]}`;
  }

  // Bundled plugin asset path:
  // /plugins/<plugin>/printers/assets/<...>
  const bundledMatch = trimmed.match(/^\/?plugins\/[^/]+\/printers\/(assets\/.+)$/i);
  if (bundledMatch?.[1]) {
    return `./${bundledMatch[1]}`;
  }

  return trimmed;
}

function buildPrinterAssetPreviewCandidates(assetPath: string, context: AssetPreviewContext = {}): string[] {
  const trimmed = assetPath.trim();
  if (!trimmed) return [];

  const candidates: string[] = [];
  const addCandidate = (candidate: string) => {
    const value = candidate.trim();
    if (!value) return;
    if (!candidates.includes(value)) candidates.push(value);
  };

  const isAbsolute = /^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed) || /^blob:/i.test(trimmed);
  if (isAbsolute) {
    addCandidate(trimmed);
    return candidates;
  }

  if (trimmed.startsWith('/api/profile-assets/') || trimmed.startsWith('/plugins/') || trimmed.startsWith('/printers/')) {
    addCandidate(toRuntimeAssetPath(trimmed));
    return candidates;
  }

  const relativeAsset = normalizeAssetRelativePath(trimmed)
    .replace(/^printers\//i, '');

  const githubSource = parseGithubOwnerRepoFromAnyUrl(context.sourceUrl ?? '')
    ?? parseGithubOwnerRepoFromAnyUrl(context.homepage ?? '');

  const normalizePluginAssetNamespaceCandidates = (value: string): string[] => {
    const trimmed = value.trim();
    if (!trimmed) return [];

    const candidates = new Set<string>();
    const base = trimmed.replace(/^df-plugin-/i, '');

    candidates.add(base);
    candidates.add(base.replace(/-printer-profiles$/i, ''));
    candidates.add(base.replace(/-material-profiles$/i, ''));
    candidates.add(base.replace(/-builtin$/i, ''));

    return Array.from(candidates)
      .map((candidate) => candidate.trim())
      .filter(Boolean);
  };

  const pluginCandidates = new Set<string>();
  const addPluginCandidate = (value: string | undefined) => {
    const normalized = value?.trim();
    if (!normalized) return;
    normalizePluginAssetNamespaceCandidates(normalized)
      .forEach((candidate) => pluginCandidates.add(candidate));
  };

  addPluginCandidate(context.pluginId);
  addPluginCandidate(context.pluginSlug);
  if (pluginCandidates.size === 0 && githubSource) {
    addPluginCandidate(githubSource.repo);
  }

  pluginCandidates.forEach((plugin) => {
    addCandidate(toRuntimeAssetPath(`/plugins/${plugin}/printers/${relativeAsset}`));
  });

  if (githubSource) {
    addCandidate(`https://raw.githubusercontent.com/${githubSource.owner}/${githubSource.repo}/main/printers/${relativeAsset}`);
  }

  return candidates.slice(0, 6);
}

function asResinFamily(value: unknown, fallback: MaterialDraft['resinFamily']): MaterialDraft['resinFamily'] {
  const candidate = asString(value, fallback);
  if (candidate === 'standard' || candidate === 'abs-like' || candidate === 'tough' || candidate === 'flexible' || candidate === 'engineering' || candidate === 'other') {
    return candidate;
  }
  return fallback;
}

function parsePrinterPresetDraft(value: unknown): PrinterPresetDraft {
  if (!isRecord(value)) return { ...DEFAULT_PRINTER_PRESET };

  const display = isRecord(value.display) ? value.display : {};
  const buildVolume = isRecord(value.buildVolumeMm) ? value.buildVolumeMm : {};
  const pixelSize = isRecord(value.pixelSize) ? value.pixelSize : {};
  const safetyMargin = isRecord(value.safetyMarginMm) ? value.safetyMarginMm : {};
  const bitDepth = isRecord(value.bitDepth) ? value.bitDepth : {};

  const resolutionX = asNumber(display.resolutionX);
  const resolutionY = asNumber(display.resolutionY);
  const pixelSizeX = asNumber(pixelSize.x);
  const pixelSizeY = asNumber(pixelSize.y);

  const hasExplicitWidth = typeof buildVolume.width === 'number' && Number.isFinite(buildVolume.width);
  const hasExplicitDepth = typeof buildVolume.depth === 'number' && Number.isFinite(buildVolume.depth);
  const autoBuildWidthDepth = !hasExplicitWidth || !hasExplicitDepth;

  const computedWidth = resolutionX > 0 && pixelSizeX > 0 ? computeBuildDimensionMm(resolutionX, pixelSizeX) : 0;
  const computedDepth = resolutionY > 0 && pixelSizeY > 0 ? computeBuildDimensionMm(resolutionY, pixelSizeY) : 0;

  return {
    presetId: asString(value.presetId),
    manufacturer: asString(value.manufacturer),
    family: asString(value.family),
    name: asString(value.name),
    imageAssetPath: normalizeImportedImageAssetPath(asString(value.imageAssetPath)),
    outputFormat: asString(display.outputFormat),
    formatVersion: asString(display.formatVersion),
    settingsMode: asString(display.settingsMode),
    networkSupport: asString(value.networkSupport),
    networkFilter: asString(value.networkFilter),
    hasCamera: asBoolean(value.hasCamera, true),
    webcamRotationDeg: normalizeWebcamRotation(display.webcamRotationDeg),
    resolutionX,
    resolutionY,
    bitDepth: Math.max(1, Math.round(asNumber(bitDepth.bits, 8))),
    mirrorX: asBoolean(display.mirrorX),
    mirrorY: asBoolean(display.mirrorY),
    autoBuildWidthDepth,
    buildWidth: hasExplicitWidth ? asNumber(buildVolume.width) : computedWidth,
    buildDepth: hasExplicitDepth ? asNumber(buildVolume.depth) : computedDepth,
    buildHeight: asNumber(buildVolume.height),
    frontMargin: asNumber(safetyMargin.front),
    backMargin: asNumber(safetyMargin.back),
    leftMargin: asNumber(safetyMargin.left),
    rightMargin: asNumber(safetyMargin.right),
    pixelSizeX,
    pixelSizeY,
    antiAliasing: asBoolean(value.antiAliasing),
  };
}

function cloneLocalSettingsByOutput(source: LocalSettingsByOutputDraft): LocalSettingsByOutputDraft {
  const next: LocalSettingsByOutputDraft = {};
  Object.entries(source).forEach(([format, settings]) => {
    next[format] = { ...settings };
  });
  return next;
}

function parseMaterialTemplateDrafts(value: unknown): MaterialTemplateDraft[] {
  if (!isRecord(value)) {
    return [createDefaultMaterialTemplateDraft()];
  }

  const rawScaleComp = isRecord(value.scaleCompensationPct) ? value.scaleCompensationPct : {};
  const rawLocalSettings = isRecord(value.localSettingsByOutput) ? value.localSettingsByOutput : {};
  const localSettingsByOutput: LocalSettingsByOutputDraft = {};

  Object.entries(rawLocalSettings).forEach(([format, settings]) => {
    if (!isRecord(settings)) return;

    const nextSettings: LocalMaterialSettingsMap = {};
    Object.entries(settings).forEach(([settingKey, settingValue]) => {
      if (typeof settingValue === 'string' || typeof settingValue === 'number' || typeof settingValue === 'boolean') {
        nextSettings[settingKey] = settingValue as LocalMaterialSettingsValue;
      }
    });

    if (Object.keys(nextSettings).length === 0) return;
    localSettingsByOutput[format] = nextSettings;
  });

  const validForPresets = Array.isArray(value.validForPresets)
    ? value.validForPresets
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    : [];

  const baseTemplate: MaterialTemplateDraft = {
    draft: {
      ...DEFAULT_MATERIAL_DRAFT,
      name: asString(value.name, DEFAULT_MATERIAL_DRAFT.name),
      brand: asString(value.brand, DEFAULT_MATERIAL_DRAFT.brand),
      currencyCode: asString(value.currencyCode, DEFAULT_MATERIAL_DRAFT.currencyCode),
      bottlePrice: asNumber(value.bottlePrice, DEFAULT_MATERIAL_DRAFT.bottlePrice),
      bottleCapacityMl: asNumber(value.bottleCapacityMl, DEFAULT_MATERIAL_DRAFT.bottleCapacityMl),
      resinFamily: asResinFamily(value.resinFamily, DEFAULT_MATERIAL_DRAFT.resinFamily),
      scaleCompensationPct: {
        x: asNumber(rawScaleComp.x, DEFAULT_MATERIAL_DRAFT.scaleCompensationPct.x),
        y: asNumber(rawScaleComp.y, DEFAULT_MATERIAL_DRAFT.scaleCompensationPct.y),
        z: asNumber(rawScaleComp.z, DEFAULT_MATERIAL_DRAFT.scaleCompensationPct.z),
      },
      layerHeightMm: asNumber(value.layerHeightMm, DEFAULT_MATERIAL_DRAFT.layerHeightMm),
      normalExposureSec: asNumber(value.normalExposureSec, DEFAULT_MATERIAL_DRAFT.normalExposureSec),
      bottomExposureSec: asNumber(value.bottomExposureSec, DEFAULT_MATERIAL_DRAFT.bottomExposureSec),
      bottomLayerCount: asNumber(value.bottomLayerCount, DEFAULT_MATERIAL_DRAFT.bottomLayerCount),
      liftDistanceMm: asNumber(value.liftDistanceMm, DEFAULT_MATERIAL_DRAFT.liftDistanceMm),
      liftSpeedMmMin: asNumber(value.liftSpeedMmMin, DEFAULT_MATERIAL_DRAFT.liftSpeedMmMin),
      retractSpeedMmMin: asNumber(value.retractSpeedMmMin, DEFAULT_MATERIAL_DRAFT.retractSpeedMmMin),
      minimumAaAlphaPercent: asNumber(value.minimumAaAlphaPercent, DEFAULT_MATERIAL_DRAFT.minimumAaAlphaPercent),
    },
    localSettingsByOutput,
    targetPresetId: '',
  };

  if (validForPresets.length === 0) {
    return [baseTemplate];
  }

  return validForPresets.map((presetId) => ({
    draft: { ...baseTemplate.draft },
    localSettingsByOutput: cloneLocalSettingsByOutput(baseTemplate.localSettingsByOutput),
    targetPresetId: presetId,
  }));
}

// ─── Step: Details ────────────────────────────────────────────────────────────

type StepDetailsProps = {
  meta: PluginMeta;
  onChange: (next: PluginMeta) => void;
  onImportManifest: (rawText: string) => ImportManifestResult;
  installedPlugins: Array<{ id: string; name: string; version: string; sourceLabel: string }>;
  onImportInstalledPlugin: (pluginId: string) => ImportManifestResult;
  incompleteFields: string[];
};

function StepDetails({ meta, onChange, onImportManifest, installedPlugins, onImportInstalledPlugin, incompleteFields }: StepDetailsProps) {
  const [importManifestText, setImportManifestText] = React.useState('');
  const [selectedInstalledPluginId, setSelectedInstalledPluginId] = React.useState('');
  const [importFeedback, setImportFeedback] = React.useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [editSourceMode, setEditSourceMode] = React.useState<'installed' | 'json'>(() => (installedPlugins.length > 0 ? 'installed' : 'json'));
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (!installedPlugins.length) {
      setSelectedInstalledPluginId('');
      if (editSourceMode === 'installed') setEditSourceMode('json');
      return;
    }

    const hasCurrent = installedPlugins.some((plugin) => plugin.id === selectedInstalledPluginId);
    if (hasCurrent) return;
    setSelectedInstalledPluginId(installedPlugins[0].id);
  }, [editSourceMode, installedPlugins, selectedInstalledPluginId]);

  const installedPluginOptions = React.useMemo(
    () => installedPlugins.map((plugin) => ({
      value: plugin.id,
      label: `${plugin.name} v${plugin.version} · ${plugin.sourceLabel}`,
    })),
    [installedPlugins],
  );

  const switchEditMode = React.useCallback((mode: 'installed' | 'json') => {
    setEditSourceMode(mode);
    setImportFeedback(null);
  }, []);

  const handleImport = React.useCallback(() => {
    const result = onImportManifest(importManifestText);
    setImportFeedback({
      type: result.ok ? 'success' : 'error',
      message: result.message,
    });
  }, [importManifestText, onImportManifest]);

  const handleImportInstalledPlugin = React.useCallback(() => {
    const result = onImportInstalledPlugin(selectedInstalledPluginId);
    setImportFeedback({
      type: result.ok ? 'success' : 'error',
      message: result.message,
    });
  }, [onImportInstalledPlugin, selectedInstalledPluginId]);

  const handlePickFile = React.useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChosen = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const content = await file.text();
      setImportManifestText(content);
      setEditSourceMode('json');
      setImportFeedback({
        type: 'success',
        message: `Loaded ${file.name}. Click "Import into Studio" to apply it.`,
      });
    } catch {
      setImportFeedback({
        type: 'error',
        message: 'Unable to read selected file. Try again or paste the manifest manually.',
      });
    } finally {
      event.currentTarget.value = '';
    }
  }, []);

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1">
        <div className="space-y-4 pb-4">
          <div className="rounded-xl border p-3 space-y-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
            <div className="ui-meta font-semibold uppercase tracking-wide">Identity</div>
            <div className="grid grid-cols-2 gap-3">
              <LabeledInput
                label="Display Name"
                helpText="Full name shown in the plugin manager (e.g. Siraya Tech)"
                value={meta.name}
                onChange={(v) => onChange({ ...meta, name: v })}
              />
              <div className="space-y-1">
                <span className="ui-label font-medium inline-flex items-center gap-1.5">
                  Slug
                  <span
                    title="Lowercase identifier used in the repository name and manifest ID"
                    className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[9px] font-semibold cursor-help"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-2)' }}
                  >?</span>
                </span>
                <div className="flex items-center">
                  <span
                    className="font-mono text-xs px-2 h-[36px] flex items-center rounded-l border-y border-l shrink-0"
                    style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), black 8%)', color: 'var(--text-muted)' }}
                  >
                    df-plugin-
                  </span>
                  <input
                    type="text"
                    value={meta.slug}
                    onChange={(e) => onChange({ ...meta, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                    placeholder="myplugin"
                    className="ui-input flex-1 h-[36px] px-2.5 leading-tight text-sm"
                    style={{ borderRadius: '0 var(--radius) var(--radius) 0' }}
                  />
                </div>
              </div>
              <LabeledInput label="Version" value={meta.version} onChange={(v) => onChange({ ...meta, version: v })} />
              <LabeledInput label="Author" helpText="Company or person name" value={meta.author} onChange={(v) => onChange({ ...meta, author: v })} />
              <LabeledInput
                label="GitHub Owner"
                helpText="Username or organization (e.g. Open-Resin-Alliance)"
                value={meta.githubOwner}
                onChange={(v) => onChange({ ...meta, githubOwner: normalizeGithubOwner(v) })}
              />
              <LabeledInput label="Description" helpText="Brief description shown in the plugin manager" value={meta.description} onChange={(v) => onChange({ ...meta, description: v })} />
              <LabeledInput label="Repository URL" helpText="Link to your GitHub repository or website" value={meta.homepage} onChange={(v) => onChange({ ...meta, homepage: v })} />
            </div>
          </div>

          <div className="rounded-xl border p-3 space-y-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="ui-meta font-semibold uppercase tracking-wide">Edit Existing Plugin</div>
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  Load an installed <strong>simple plugin</strong>, or import manifest JSON directly.
                </div>
              </div>
              <div className="inline-flex items-center rounded-md border p-0.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <button
                  type="button"
                  onClick={() => switchEditMode('installed')}
                  className="ui-button ui-button-ghost !h-7 !px-2.5 text-[11px]"
                  style={editSourceMode === 'installed' ? ACCENT_SECONDARY_BUTTON_STYLE_90 : undefined}
                >
                  Installed
                </button>
                <button
                  type="button"
                  onClick={() => switchEditMode('json')}
                  className="ui-button ui-button-ghost !h-7 !px-2.5 text-[11px]"
                  style={editSourceMode === 'json' ? ACCENT_SECONDARY_BUTTON_STYLE_90 : undefined}
                >
                  JSON
                </button>
              </div>
            </div>

            <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              {editSourceMode === 'installed' ? (
                installedPlugins.length === 0 ? (
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    No installed simple plugins found yet. Switch to JSON mode to import a manifest file.
                  </div>
                ) : (
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-end">
                    <SelectDropdown
                      label="Installed Simple Plugin"
                      value={selectedInstalledPluginId}
                      onChange={(value) => setSelectedInstalledPluginId(value)}
                      options={installedPluginOptions}
                      className="space-y-1 block"
                      labelClassName="font-medium"
                      selectClassName="w-full h-[36px] px-2.5 pr-10 text-xs"
                    />
                    <button
                      type="button"
                      onClick={handleImportInstalledPlugin}
                      disabled={!selectedInstalledPluginId}
                      className="ui-button ui-button-secondary !h-[36px] !px-3 text-xs disabled:opacity-50"
                      style={ACCENT_SECONDARY_BUTTON_STYLE_92}
                    >
                      Load Plugin
                    </button>
                  </div>
                )
              ) : (
                <div className="space-y-2.5">
                  <textarea
                    value={importManifestText}
                    onChange={(event) => setImportManifestText(event.target.value)}
                    placeholder="Paste your dragonfruit-plugin.json content here…"
                    rows={6}
                    className="ui-input w-full px-2.5 py-2 text-xs font-mono leading-relaxed"
                    style={{ resize: 'vertical' }}
                  />

                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={handlePickFile}
                      className="ui-button ui-button-secondary !h-8 !px-3 text-xs"
                    >
                      Load from File
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      onChange={handleFileChosen}
                    />

                    <button
                      type="button"
                      onClick={handleImport}
                      disabled={importManifestText.trim().length === 0}
                      className="ui-button ui-button-secondary !h-8 !px-3 text-xs disabled:opacity-50"
                      style={ACCENT_SECONDARY_BUTTON_STYLE_92}
                    >
                      Import into Studio
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setImportManifestText('');
                        setImportFeedback(null);
                      }}
                      className="ui-button ui-button-secondary !h-8 !px-3 text-xs"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}
            </div>

            {importFeedback && (
              <div
                className="rounded-lg border px-2.5 py-2 text-xs"
                style={importFeedback.type === 'success'
                  ? {
                    borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)',
                    background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-2) 92%)',
                    color: 'color-mix(in srgb, var(--accent-secondary), var(--text-strong) 24%)',
                  }
                  : {
                    borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 45%)',
                    background: 'color-mix(in srgb, var(--danger), var(--surface-2) 92%)',
                    color: 'color-mix(in srgb, var(--danger), var(--text-strong) 24%)',
                  }}
              >
                {importFeedback.message}
              </div>
            )}
          </div>

          {incompleteFields.length > 0 && (
            <div className="rounded-xl border px-3 py-2.5" style={{ borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 45%)', background: 'color-mix(in srgb, #d97706, var(--surface-2) 92%)' }}>
              <div className="text-xs font-semibold" style={{ color: 'color-mix(in srgb, #d97706, var(--text-strong) 20%)' }}>
                Complete Plugin Details to unlock the next steps
              </div>
              <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                Remaining fields: {incompleteFields.join(', ')}
              </div>
            </div>
          )}

          {meta.slug && (
            <div className="rounded-xl border px-3 py-2 flex items-center gap-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Plugin ID:</span>
              <code className="font-mono text-xs font-semibold" style={{ color: 'var(--accent-secondary)' }}>
                {meta.slug.startsWith('df-plugin-') ? meta.slug.slice('df-plugin-'.length) : meta.slug}
              </code>
            </div>
          )}
        </div>
      </div>

      <div
        className="mt-3 shrink-0 rounded-xl border px-4 py-3"
        style={{
          borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 36%)',
          background: 'color-mix(in srgb, #d97706, var(--surface-1) 92%)',
          boxShadow: '0 -1px 0 color-mix(in srgb, #d97706, transparent 84%)',
        }}
      >
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: '#d97706' }} />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold leading-5" style={{ color: 'var(--text-strong)' }}>
              Development Build Warning
            </div>
            <div className="mt-0.5 text-[12px] font-medium leading-5" style={{ color: 'var(--text-muted)' }}>
              You are running a development build of <span style={{ color: 'var(--text-strong)' }}>DragonFruit</span>. Plugin Creation Studio is intended for developers, integrators, and OEM partners creating or maintaining printer and material profile packs. Changes made here can overwrite or replace local plugin data, so review edits carefully before importing, editing, or writing files.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Step: Repo ───────────────────────────────────────────────────────────────

type StepRepoProps = { meta: PluginMeta };

function RepoStep({ n, title, description, children }: { n: number; title: string; description: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-3 space-y-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
      <div className="flex items-center gap-3">
        <span
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 40%)',
            color: 'var(--accent-secondary)',
            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 88%)',
          }}
        >
          {n}
        </span>
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{title}</span>
          <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>{description}</span>
        </div>
      </div>
      {children && <div className="pl-9 space-y-2">{children}</div>}
    </div>
  );
}

function StepRepo({ meta }: StepRepoProps) {
  const [copiedRepoLink, setCopiedRepoLink] = React.useState(false);

  const slug = meta.slug || 'my-plugin';
  const repoName = `df-plugin-${slug}`;
  const parsedHomepageRepo = parseGithubRepoUrl(meta.homepage);
  const homepageOwner = parsedHomepageRepo?.owner ?? null;
  const explicitOwner = normalizeGithubOwner(meta.githubOwner);
  const resolvedOwner = explicitOwner || homepageOwner || '';
  const hasValidOwner = isValidGithubOwner(resolvedOwner);
  const hasHomepageRepoUrl = parsedHomepageRepo !== null;
  const repoOwnerSuggestion = hasValidOwner ? resolvedOwner : '<owner>';
  const suggestedRepoUrl = `https://github.com/${repoOwnerSuggestion}/${repoName}`;
  const repoUrl = hasHomepageRepoUrl
    ? meta.homepage.trim()
    : hasValidOwner
      ? `https://github.com/${resolvedOwner}/${repoName}`
      : suggestedRepoUrl;

  const copyRepoLink = React.useCallback(async () => {
    if (!repoUrl) return;
    try {
      await navigator.clipboard.writeText(repoUrl);
      setCopiedRepoLink(true);
      window.setTimeout(() => setCopiedRepoLink(false), 2000);
    } catch {
      // no-op
    }
  }, [repoUrl]);

  const initCmd = `git init ${repoName}\ncd ${repoName}`;
  const commitCmd = `git add .\ngit commit -m "Initial plugin setup"\ngit remote add origin ${repoUrl || '<set-valid-github-owner-or-repo-url>'}\ngit push -u origin main`;
  const submoduleCmd = `git submodule add ${repoUrl || '<set-valid-github-owner-or-repo-url>'} plugins/${slug}`;

  const fileTree = `${repoName}/\n├── dragonfruit-plugin.json   ← generated in Export step\n└── README.md`;

  return (
    <div className="space-y-2.5">
      {/* Identity bar */}
      <div
        className="rounded-xl border px-3 py-2.5 flex items-center justify-between gap-3"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
      >
        <div>
          <div className="text-[10px] uppercase font-semibold tracking-wide mb-0.5" style={{ color: 'var(--text-muted)' }}>Repository</div>
          <code className="font-mono text-sm font-semibold" style={{ color: 'var(--accent-secondary)' }}>{repoName}</code>
        </div>
        {repoUrl && (
          <button
            type="button"
            onClick={() => { void copyRepoLink(); }}
            className="ui-button ui-button-secondary !h-8 !px-3 text-xs inline-flex items-center gap-1.5 shrink-0"
            style={ACCENT_SECONDARY_BUTTON_STYLE_92}
          >
            <Copy className="h-3.5 w-3.5" />
            {copiedRepoLink ? 'Copied!' : 'Copy GitHub Link'}
          </button>
        )}
        {!hasHomepageRepoUrl && !hasValidOwner && (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Set a valid GitHub owner/org in Plugin Details to generate repo commands
          </span>
        )}
      </div>

      {/* Step 1 */}
      <RepoStep n={1} title="Initialize locally" description="Create the repository folder and set up Git.">
        <CodeBlock label="Terminal" content={initCmd} />
      </RepoStep>

      {/* Step 2 */}
      <RepoStep n={2} title="Create on GitHub" description="Create a repository with this exact naming pattern.">
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Create a new GitHub repository named <code className="font-mono">{repoName}</code>.
          <br />
          Example: if your slug is <code className="font-mono">elegoo</code>, create <code className="font-mono">df-plugin-elegoo</code>.
        </div>
        <CodeBlock label="Suggested repository URL" content={suggestedRepoUrl} />
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Replace <code className="font-mono">&lt;owner&gt;</code> with your GitHub username/org. To set a custom repository URL, edit <strong>Repository URL</strong> in Plugin Details.
        </div>
      </RepoStep>

      {/* Step 3 */}
      <RepoStep n={3} title="Add exported files" description="Use files generated in the Export step.">
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Export automatically prepares both <code className="font-mono">dragonfruit-plugin.json</code> and <code className="font-mono">README.md</code>.
        </div>
        <CodeBlock label="Repository structure" content={fileTree} />
      </RepoStep>

      {/* Step 4 */}
      <RepoStep n={4} title="Commit &amp; push" description="Publish your plugin to GitHub.">
        <CodeBlock label="Terminal" content={commitCmd} />
      </RepoStep>

      {/* Step 5 */}
      <RepoStep n={5} title="Install in DragonFruit" description="Two ways to load the plugin.">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border p-2.5 space-y-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>GitHub URL Install</div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Settings → Plugins → Install from GitHub URL</div>
            <code className="block font-mono text-[11px] mt-1 break-all" style={{ color: 'var(--accent-secondary)' }}>{repoUrl}</code>
          </div>
          <div className="rounded-lg border p-2.5 space-y-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Git Submodule</div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>From your DragonFruit directory:</div>
            <code className="block font-mono text-[11px] mt-1 break-all" style={{ color: 'var(--accent-secondary)' }}>{submoduleCmd}</code>
            <div className="mt-2 rounded-md border px-2 py-1.5 text-[11px]" style={{ borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)', background: 'color-mix(in srgb, #d97706, var(--surface-2) 92%)', color: 'var(--text-muted)' }}>
              If you use the submodule route, also register the plugin in{' '}
              <code className="font-mono">src/config/builtin-simple-plugin-allowlist.json</code>{' '}
              so it is included in generated built-in plugin manifests.
            </div>
          </div>
        </div>
      </RepoStep>
    </div>
  );
}

function CodeBlock({ label, content }: { label: string; content: string }) {
  const [copied, setCopied] = React.useState(false);

  // Detect language from label
  const detectLanguage = (label: string): string => {
    const lower = label.toLowerCase();
    if (lower.includes('json') || lower.includes('dragonfruit')) return 'json';
    if (lower.includes('readme') || lower.includes('markdown')) return 'markdown';
    if (lower.includes('terminal') || lower.includes('git') || lower.includes('init') || lower.includes('commit')) return 'bash';
    if (lower.includes('structure') || lower.includes('tree')) return 'plaintext';
    if (lower.includes('url') || lower.includes('repository')) return 'plaintext';
    return 'plaintext';
  };

  const language = detectLanguage(label);
  let highlightedHtml = content;

  try {
    if (language !== 'plaintext') {
      const result = hljs.highlight(content, { language, ignoreIllegals: true });
      highlightedHtml = result.value;
    }
  } catch (e) {
    // Fallback to plain text if highlighting fails
    highlightedHtml = content;
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* no-op */ }
  };

  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
      <div className="px-3 py-1.5 border-b flex items-center justify-between" style={{ background: 'var(--surface-2)', borderColor: 'var(--border-subtle)' }}>
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 text-[11px] px-1.5 h-5 rounded border transition-colors"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
          aria-label="Copy"
        >
          <Copy className="h-3 w-3" />
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre
        className="text-xs font-mono px-3 py-2 overflow-x-auto leading-relaxed hljs"
        style={{
          background: '#282c34',
          color: '#abb2bf',
        }}
      ><code dangerouslySetInnerHTML={{ __html: highlightedHtml }} /></pre>
    </div>
  );
}

// ─── Step: Content ────────────────────────────────────────────────────────────

type StepContentProps = {
  includesPrinters: boolean;
  setIncludesPrinters: (v: boolean) => void;
  includesMaterials: boolean;
  setIncludesMaterials: (v: boolean) => void;
};

function StepContent({ includesPrinters, setIncludesPrinters, includesMaterials, setIncludesMaterials }: StepContentProps) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>What does this plugin include?</div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
          Select the content types to include. You can pick one or both.
        </div>
      </div>

      <div className="space-y-2">
        {([
          {
            kind: 'printers' as const,
            Icon: Printer,
            label: 'Printer Presets',
            sub: 'Manufacturer + model catalog, display geometry, and output format defaults.',
            checked: includesPrinters,
            toggle: setIncludesPrinters,
          },
          {
            kind: 'materials' as const,
            Icon: FlaskConical,
            label: 'Material Presets',
            sub: 'Reusable material profiles. Can target all printers or specific printer presets.',
            checked: includesMaterials,
            toggle: setIncludesMaterials,
          },
        ] as const).map(({ kind, Icon, label, sub, checked, toggle }) => (
          <button
            key={kind}
            type="button"
            onClick={() => toggle(!checked)}
            className="w-full rounded-xl border text-left transition-colors"
            style={{
              borderColor: checked
                ? 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 35%)'
                : 'var(--border-subtle)',
              background: checked
                ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-2) 92%)'
                : 'var(--surface-2)',
            }}
          >
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors"
                style={{
                  borderColor: checked ? 'var(--accent-secondary)' : 'var(--border-subtle)',
                  background: checked ? 'var(--accent-secondary)' : 'transparent',
                }}
              >
                {checked && <Check className="h-3 w-3" style={{ color: 'var(--accent-secondary-contrast)' }} />}
              </span>

              <span
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border"
                style={{
                  borderColor: checked
                    ? 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 50%)'
                    : 'var(--border-subtle)',
                  background: checked
                    ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 82%)'
                    : 'var(--surface-1)',
                }}
              >
                <Icon
                  className="h-4 w-4"
                  style={{ color: checked ? 'var(--accent-secondary)' : 'var(--text-muted)' }}
                />
              </span>

              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>{label}</div>
                <div className="text-[11px] mt-0.5 leading-snug" style={{ color: 'var(--text-muted)' }}>{sub}</div>
              </div>

              {checked && (
                <span
                  className="text-[10px] font-bold uppercase tracking-widest shrink-0 px-1.5 py-0.5 rounded"
                  style={{
                    color: 'color-mix(in srgb, var(--accent-secondary), var(--text-strong) 28%)',
                    background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-2) 82%)',
                  }}
                >
                  On
                </span>
              )}
            </div>
          </button>
        ))}
      </div>

      {!includesPrinters && !includesMaterials && (
        <div
          className="rounded-xl border px-3 py-2.5 text-xs"
          style={{
            borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 45%)',
            background: 'color-mix(in srgb, #d97706, var(--surface-2) 92%)',
            color: 'color-mix(in srgb, #d97706, var(--text-strong) 20%)',
          }}
        >
          Select at least one content type to continue.
        </div>
      )}
    </div>
  );
}

// ─── Printer Preset Editor ────────────────────────────────────────────────────

type PrinterPresetEditorProps = {
  preset: PrinterPresetDraft;
  onChange: (next: PrinterPresetDraft) => void;
};

function PrinterPresetEditor({ preset, onChange }: PrinterPresetEditorProps) {
  const formatVersionOptions = React.useMemo(
    () => getAvailableFormatVersionOptions(preset.outputFormat || null),
    [preset.outputFormat],
  );
  const settingsModeOptions = React.useMemo(
    () => getAvailableSettingsModeOptions(preset.outputFormat || null),
    [preset.outputFormat],
  );
  const resolvedBuildWidth = preset.autoBuildWidthDepth
    ? (preset.resolutionX > 0 && preset.pixelSizeX > 0 ? computeBuildDimensionMm(preset.resolutionX, preset.pixelSizeX) : 0)
    : preset.buildWidth;
  const resolvedBuildDepth = preset.autoBuildWidthDepth
    ? (preset.resolutionY > 0 && preset.pixelSizeY > 0 ? computeBuildDimensionMm(preset.resolutionY, preset.pixelSizeY) : 0)
    : preset.buildDepth;
  const networkModeOptions = React.useMemo(() => {
    const registered = getAvailableProfileNetworkModes();
    const base = [
      { value: '', label: 'None (Local only)' },
      ...registered.map((mode) => ({ value: mode.mode, label: mode.displayName })),
    ];
    const currentMode = preset.networkSupport.trim().toLowerCase();
    if (!currentMode) return base;
    if (base.some((option) => option.value === currentMode)) return base;
    return [...base, { value: currentMode, label: `Unknown (${currentMode})` }];
  }, [preset.networkSupport]);
  const suggestedAssetPath = React.useMemo(
    () => buildSuggestedPrinterAssetPath(preset),
    [preset],
  );

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <LabeledInput label="Manufacturer" helpText="Brand name (e.g. Elegoo)" value={preset.manufacturer} onChange={(v) => onChange({ ...preset, manufacturer: v })} />
        <LabeledInput label="Name" helpText="Model name (e.g. Saturn 4 Ultra)" value={preset.name} onChange={(v) => onChange({ ...preset, name: v })} />
        <LabeledInput label="Family" helpText="Groups related models (e.g. Saturn 4 Series)" value={preset.family} onChange={(v) => onChange({ ...preset, family: v })} />
        <LabeledInput label="Preset ID" helpText="Unique lowercase ID (e.g. elegoo-saturn-4-ultra)" value={preset.presetId} onChange={(v) => onChange({ ...preset, presetId: v.toLowerCase().replace(/\s+/g, '-') })} />
      </div>

      <div className="rounded-xl border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="ui-meta font-semibold uppercase tracking-wide mb-1.5">Assets</div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-end">
          <LabeledInput
            label="Image Asset Path"
            helpText="Relative path in plugin repo (e.g. ./assets/mars/mars-4-ultra.png)"
            value={preset.imageAssetPath}
            onChange={(v) => onChange({ ...preset, imageAssetPath: v })}
          />
          <button
            type="button"
            onClick={() => onChange({ ...preset, imageAssetPath: suggestedAssetPath })}
            className="ui-button ui-button-secondary !h-[36px] !px-3 text-xs"
            style={ACCENT_SECONDARY_BUTTON_STYLE_92}
          >
            Use Suggested
          </button>
        </div>
        <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Suggested: <code className="font-mono">{suggestedAssetPath}</code>
        </div>
      </div>

      <div className="rounded-xl border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="ui-meta font-semibold uppercase tracking-wide mb-1.5">Format + Output</div>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
          <SelectDropdown
            label="Output Format"
            value={preset.outputFormat}
            onChange={(v) => onChange({ ...preset, outputFormat: v, formatVersion: '', settingsMode: '' })}
            options={[{ value: '', label: '— select format —' }, ...OUTPUT_FORMAT_OPTIONS]}
            className="space-y-1 block"
            labelClassName="font-medium"
            selectClassName="w-full h-[36px] px-2.5 pr-10 leading-tight text-sm"
          />
          {formatVersionOptions.length > 0 && (
            <SelectDropdown
              label="Format Version"
              value={preset.formatVersion}
              onChange={(v) => onChange({ ...preset, formatVersion: v })}
              options={[{ value: '', label: '— default —' }, ...formatVersionOptions.map((o) => ({ value: o.value, label: o.label }))]}
              className="space-y-1 block"
              labelClassName="font-medium"
              selectClassName="w-full h-[36px] px-2.5 pr-10 leading-tight text-sm"
            />
          )}
          {settingsModeOptions.length > 0 && (
            <SelectDropdown
              label="Settings Mode"
              value={preset.settingsMode}
              onChange={(v) => onChange({ ...preset, settingsMode: v })}
              options={[{ value: '', label: '— default —' }, ...settingsModeOptions.map((o) => ({ value: o.value, label: o.label }))]}
              className="space-y-1 block"
              labelClassName="font-medium"
              selectClassName="w-full h-[36px] px-2.5 pr-10 leading-tight text-sm"
            />
          )}
          <SelectDropdown
            label="Network Support"
            value={preset.networkSupport}
            onChange={(v) => onChange({ ...preset, networkSupport: v.trim().toLowerCase() })}
            options={networkModeOptions}
            className="space-y-1 block"
            labelClassName="font-medium"
            selectClassName="w-full h-[36px] px-2.5 pr-10 leading-tight text-sm"
          />
          <LabeledInput
            label="Network Filter"
            helpText="Example: Saturn 4"
            value={preset.networkFilter}
            onChange={(v) => onChange({ ...preset, networkFilter: v })}
          />
          <LabeledToggleInput label="Webcam Support" checked={preset.hasCamera} onChange={(v) => onChange({ ...preset, hasCamera: v })} />

          {preset.hasCamera && (
            <SelectDropdown
              label="Webcam Rotation"
              value={String(preset.webcamRotationDeg)}
              onChange={(v) => onChange({ ...preset, webcamRotationDeg: normalizeWebcamRotation(v) })}
              options={WEBCAM_ROTATION_OPTIONS}
              className="space-y-1 block"
              labelClassName="font-medium"
              selectClassName="w-full h-[36px] px-2.5 pr-10 leading-tight text-sm"
            />
          )}

          <LabeledToggleInput label="Mirror X" checked={preset.mirrorX} onChange={(v) => onChange({ ...preset, mirrorX: v })} />
          <LabeledToggleInput label="Mirror Y" checked={preset.mirrorY} onChange={(v) => onChange({ ...preset, mirrorY: v })} />
        </div>
      </div>

      <div className="rounded-xl border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="ui-meta font-semibold uppercase tracking-wide mb-1.5">Display</div>
        <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
          <LabeledNumberInput label="Resolution X (px)" value={preset.resolutionX} onChange={(v) => onChange({ ...preset, resolutionX: v })} />
          <LabeledNumberInput label="Resolution Y (px)" value={preset.resolutionY} onChange={(v) => onChange({ ...preset, resolutionY: v })} />
          <LabeledNumberInput label="Bit Depth" value={preset.bitDepth} onChange={(v) => onChange({ ...preset, bitDepth: Math.max(1, Math.round(v)) })} />
          <LabeledNumberInput label="Pixel Size X (µm)" value={preset.pixelSizeX} onChange={(v) => onChange({ ...preset, pixelSizeX: v })} />
          <LabeledNumberInput label="Pixel Size Y (µm)" value={preset.pixelSizeY} onChange={(v) => onChange({ ...preset, pixelSizeY: v })} />
          <LabeledToggleInput label="Anti-aliasing" checked={preset.antiAliasing} onChange={(v) => onChange({ ...preset, antiAliasing: v })} />
        </div>
      </div>

      <div className="rounded-xl border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="ui-meta font-semibold uppercase tracking-wide mb-1.5">Build Volume (mm)</div>
        <div
          className="mb-1.5 rounded-lg border p-1.5 flex items-center justify-between gap-2"
          style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 6%)' }}
        >
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Auto-calculate width/depth from resolution × pixel size
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={preset.autoBuildWidthDepth}
            onClick={() => onChange({ ...preset, autoBuildWidthDepth: !preset.autoBuildWidthDepth })}
            className="ui-button ui-button-secondary !h-7 !px-2.5 text-[11px]"
            style={preset.autoBuildWidthDepth ? ACCENT_SECONDARY_BUTTON_STYLE_90 : undefined}
          >
            {preset.autoBuildWidthDepth ? 'Auto' : 'Manual'}
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <LabeledNumberInput label="Width" disabled={preset.autoBuildWidthDepth} value={resolvedBuildWidth} onChange={(v) => onChange({ ...preset, buildWidth: v })} />
          <LabeledNumberInput label="Depth" disabled={preset.autoBuildWidthDepth} value={resolvedBuildDepth} onChange={(v) => onChange({ ...preset, buildDepth: v })} />
          <LabeledNumberInput label="Height" value={preset.buildHeight} onChange={(v) => onChange({ ...preset, buildHeight: v })} />
        </div>
        <div className="mt-1.5 grid grid-cols-2 xl:grid-cols-4 gap-2">
          <LabeledNumberInput label="Front Margin (mm)" value={preset.frontMargin} onChange={(v) => onChange({ ...preset, frontMargin: v })} />
          <LabeledNumberInput label="Back Margin (mm)" value={preset.backMargin} onChange={(v) => onChange({ ...preset, backMargin: v })} />
          <LabeledNumberInput label="Left Margin (mm)" value={preset.leftMargin} onChange={(v) => onChange({ ...preset, leftMargin: v })} />
          <LabeledNumberInput label="Right Margin (mm)" value={preset.rightMargin} onChange={(v) => onChange({ ...preset, rightMargin: v })} />
        </div>
      </div>
    </div>
  );
}

// ─── Step: Printers ───────────────────────────────────────────────────────────

type DeleteConfirmDialogProps = {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
};

function DeleteConfirmDialog({ isOpen, title, message, confirmLabel, onCancel, onConfirm }: DeleteConfirmDialogProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border shadow-2xl"
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
          boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
        }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2.5">
            <span
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
              style={{
                borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 55%)',
                background: 'color-mix(in srgb, var(--danger), var(--surface-1) 88%)',
                color: 'color-mix(in srgb, var(--danger), var(--text-strong) 22%)',
              }}
            >
              <AlertTriangle className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                {title}
              </h2>
              <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {message}
              </p>
            </div>
          </div>

          <button
            type="button"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border transition-colors"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
            aria-label="Close delete confirmation"
            onClick={onCancel}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4">
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ui-button !h-9 px-3 text-xs inline-flex items-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, var(--danger), var(--surface-1) 86%)',
                color: 'color-mix(in srgb, var(--danger), var(--text-strong) 22%)',
              }}
              onClick={onConfirm}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type StepPrintersProps = { presets: PrinterPresetDraft[]; onChange: (next: PrinterPresetDraft[]) => void };

function StepPrinters({ presets, onChange }: StepPrintersProps) {
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [pendingDeletePresetIndex, setPendingDeletePresetIndex] = React.useState<number | null>(null);

  // Keep selectedIndex in bounds as list changes
  const clampedIndex = presets.length === 0 ? -1 : Math.min(selectedIndex, presets.length - 1);

  const addPreset = React.useCallback(() => {
    const next = [...presets, { ...DEFAULT_PRINTER_PRESET }];
    onChange(next);
    setSelectedIndex(next.length - 1);
  }, [presets, onChange]);

  const deletePreset = React.useCallback((index: number) => {
    const next = presets.filter((_, i) => i !== index);
    onChange(next);
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, next.length - 1)));
  }, [presets, onChange]);

  const updatePreset = React.useCallback((index: number, updated: PrinterPresetDraft) => {
    const next = [...presets];
    next[index] = updated;
    onChange(next);
  }, [presets, onChange]);

  const groupedPresets = React.useMemo(() => {
    const groups = new Map<string, { index: number; preset: PrinterPresetDraft }[]>();
    presets.forEach((preset, index) => {
      const family = preset.family?.trim() || preset.manufacturer?.trim() || 'Ungrouped';
      if (!groups.has(family)) groups.set(family, []);
      groups.get(family)?.push({ index, preset });
    });

    return Array.from(groups.entries())
      .map(([family, members]) => ({
        family,
        members: [...members].sort((a, b) => {
          const aLabel = a.preset.name?.trim() || 'New Preset';
          const bLabel = b.preset.name?.trim() || 'New Preset';
          return aLabel.localeCompare(bLabel);
        }),
      }))
      .sort((a, b) => a.family.localeCompare(b.family));
  }, [presets]);

  const selectedPreset = clampedIndex >= 0 ? presets[clampedIndex] : null;

  const requestDeletePreset = React.useCallback((index: number) => {
    setPendingDeletePresetIndex(index);
  }, []);

  const cancelDeletePreset = React.useCallback(() => {
    setPendingDeletePresetIndex(null);
  }, []);

  const confirmDeletePreset = React.useCallback(() => {
    if (pendingDeletePresetIndex === null) return;
    deletePreset(pendingDeletePresetIndex);
    setPendingDeletePresetIndex(null);
  }, [deletePreset, pendingDeletePresetIndex]);

  const pendingDeletePresetLabel = React.useMemo(() => {
    if (pendingDeletePresetIndex === null) return 'this preset';
    const target = presets[pendingDeletePresetIndex];
    return target ? [target.manufacturer, target.name].filter(Boolean).join(' ').trim() || 'this preset' : 'this preset';
  }, [pendingDeletePresetIndex, presets]);

  return (
    <>
      <div className="h-full min-h-0 flex gap-3">
      {/* Sidebar: preset list */}
      <div
        className="flex flex-col rounded-xl border overflow-hidden shrink-0"
        style={{
          width: 236,
          borderColor: 'var(--border-subtle)',
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-1), transparent 10%), color-mix(in srgb, var(--accent-secondary), var(--surface-1) 97%))',
        }}
      >
        <div
          className="px-3 py-2 border-b flex items-center justify-between gap-2"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Printer Models</span>
          <span className="text-[10px] tabular-nums px-1.5 py-0.5 rounded-md border" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>{presets.length}</span>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {presets.length === 0 ? (
            <div className="px-3 py-4 text-[11px] text-center" style={{ color: 'var(--text-muted)' }}>
              No presets yet.
            </div>
          ) : (
            groupedPresets.map(({ family, members }) => (
              <div key={family}>
                <div
                  className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest border-b flex items-center justify-between gap-2"
                  style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), black 8%)' }}
                >
                  <span className="truncate">{family}</span>
                  <span className="tabular-nums">{members.length}</span>
                </div>
                {members.map(({ index, preset }) => {
                  const label = preset.name?.trim() || 'New Preset';
                  const active = index === clampedIndex;
                  return (
                    <div
                      key={index}
                      className="group grid grid-cols-[4px_minmax(0,1fr)_auto] items-center gap-2 border-b"
                      style={{
                        borderColor: 'var(--border-subtle)',
                        background: active
                          ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 88%)'
                          : 'transparent',
                      }}
                    >
                      <span
                        className="h-full"
                        style={{
                          background: active ? 'var(--accent-secondary)' : 'transparent',
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setSelectedIndex(index)}
                        className="min-w-0 text-left py-2"
                      >
                        <div
                          className="text-xs font-medium truncate leading-tight"
                          style={{ color: active ? 'var(--accent-secondary)' : 'var(--text-strong)' }}
                        >
                          {label}
                        </div>
                        {preset.outputFormat && (
                          <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                            {preset.outputFormat}
                          </div>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => requestDeletePreset(index)}
                        className="ui-button ui-button-ghost !h-5 !w-5 !p-0 inline-flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mr-2"
                        aria-label="Delete preset"
                        title="Delete preset"
                      >
                        <Trash2 className="h-3 w-3" style={{ color: 'color-mix(in srgb, var(--danger), var(--text-strong) 22%)' }} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="p-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <button
            type="button"
            onClick={addPreset}
            className="ui-button ui-button-secondary w-full !h-8 text-[11px] flex items-center justify-center gap-1.5"
            style={ACCENT_SECONDARY_BUTTON_STYLE_92}
          >
            <Plus className="h-3.5 w-3.5" />
            Add Printer
          </button>
        </div>
      </div>

      {/* Detail editor */}
      <div className="flex-1 min-w-0 h-full">
        {selectedPreset === null ? (
          <div
            className="rounded-xl border h-full flex items-center justify-center text-xs"
            style={{ minHeight: 200, borderColor: 'var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}
          >
            Add a printer preset to get started.
          </div>
        ) : (
          <div className="rounded-xl border p-3 h-full min-h-0 flex flex-col" style={{ borderColor: 'var(--border-subtle)', background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-2), transparent 4%), var(--surface-2))' }}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                  {[selectedPreset.manufacturer, selectedPreset.name].filter(Boolean).join(' ').trim() || 'New Preset'}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {selectedPreset.family && (
                    <span className="px-1.5 py-0.5 rounded border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                      {selectedPreset.family}
                    </span>
                  )}
                  {selectedPreset.outputFormat && (
                    <span className="px-1.5 py-0.5 rounded border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                      {selectedPreset.outputFormat}
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => requestDeletePreset(clampedIndex)}
                className="ui-button ui-button-ghost !h-7 !px-2 text-[11px] flex items-center gap-1.5"
                style={{ color: 'color-mix(in srgb, var(--danger), var(--text-strong) 22%)', borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 60%)' }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1">
              <PrinterPresetEditor
                key={clampedIndex}
                preset={selectedPreset}
                onChange={(next) => updatePreset(clampedIndex, next)}
              />
            </div>
          </div>
        )}
      </div>
      </div>

      <DeleteConfirmDialog
        isOpen={pendingDeletePresetIndex !== null}
        title={`Delete ${pendingDeletePresetLabel}?`}
        message="This action cannot be undone."
        confirmLabel="Delete Preset"
        onCancel={cancelDeletePreset}
        onConfirm={confirmDeletePreset}
      />
    </>
  );
}

// ─── Step: Assets ────────────────────────────────────────────────────────────

type StepAssetsProps = {
  presets: PrinterPresetDraft[];
  onPresetsChange: (next: PrinterPresetDraft[]) => void;
  uploadedAssets: Record<string, UploadedPrinterAsset>;
  onUploadedAssetsChange: (next: Record<string, UploadedPrinterAsset>) => void;
  previewContext?: AssetPreviewContext;
};

type PrinterAssetPreviewProps = {
  alt: string;
  uploadedPreviewUrl?: string;
  pathValue: string;
  previewContext?: AssetPreviewContext;
};

function PrinterAssetPreview({ alt, uploadedPreviewUrl, pathValue, previewContext }: PrinterAssetPreviewProps) {
  const candidates = React.useMemo(() => {
    const next = uploadedPreviewUrl
      ? [uploadedPreviewUrl, ...buildPrinterAssetPreviewCandidates(pathValue, previewContext)]
      : buildPrinterAssetPreviewCandidates(pathValue, previewContext);
    return Array.from(new Set(next));
  }, [pathValue, previewContext, uploadedPreviewUrl]);

  const [candidateIndex, setCandidateIndex] = React.useState(0);
  const activeCandidate = candidates[candidateIndex];

  React.useEffect(() => {
    setCandidateIndex(0);
  }, [candidates]);

  if (!activeCandidate) {
    return (
      <div className="h-[88px] w-[88px] rounded-lg border flex items-center justify-center text-[10px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
        No image
      </div>
    );
  }

  return (
    <div className="h-[88px] w-[88px] rounded-lg border overflow-hidden p-1" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), black 4%)' }}>
      <img
        src={activeCandidate}
        alt={alt}
        className="h-full w-full object-contain"
        loading="lazy"
        onError={() => {
          setCandidateIndex((prev) => {
            if (prev + 1 < candidates.length) return prev + 1;
            return prev;
          });
        }}
      />
    </div>
  );
}

function StepAssets({ presets, onPresetsChange, uploadedAssets, onUploadedAssetsChange, previewContext }: StepAssetsProps) {
  const groupedByFamily = React.useMemo(() => {
    const groups = new Map<string, Array<{ index: number; preset: PrinterPresetDraft }>>();
    presets.forEach((preset, index) => {
      const family = preset.family.trim() || preset.manufacturer.trim() || 'Ungrouped';
      if (!groups.has(family)) groups.set(family, []);
      groups.get(family)?.push({ index, preset });
    });
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [presets]);

  const applyPresetUpdate = React.useCallback((index: number, nextPreset: PrinterPresetDraft) => {
    const next = [...presets];
    next[index] = nextPreset;
    onPresetsChange(next);
  }, [onPresetsChange, presets]);

  const handleUpload = React.useCallback((index: number, file: File | undefined) => {
    if (!file) return;
    const preset = presets[index];
    if (!preset) return;

    const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '.png';
    const familySegment = slugifyPathSegment(preset.family.trim() || preset.manufacturer.trim() || 'series');
    const modelSegment = slugifyPathSegment(preset.name.trim() || preset.presetId.trim() || `printer-${index + 1}`);
    const existingPath = preset.imageAssetPath.trim();
    const relativePath = existingPath || `./assets/${familySegment}/${modelSegment}${ext}`;
    const key = getPresetAssetUploadKey(preset, index);

    if (!existingPath) {
      applyPresetUpdate(index, { ...preset, imageAssetPath: relativePath });
    }
    const previewUrl = URL.createObjectURL(file);
    const existing = uploadedAssets[key];
    if (existing?.previewUrl) {
      URL.revokeObjectURL(existing.previewUrl);
    }
    onUploadedAssetsChange({
      ...uploadedAssets,
      [key]: { file, previewUrl },
    });
  }, [applyPresetUpdate, onUploadedAssetsChange, presets, uploadedAssets]);

  const clearUpload = React.useCallback((index: number) => {
    const preset = presets[index];
    if (!preset) return;
    const key = getPresetAssetUploadKey(preset, index);
    const nextAssets = { ...uploadedAssets };
    const existing = nextAssets[key];
    if (existing?.previewUrl) {
      URL.revokeObjectURL(existing.previewUrl);
    }
    delete nextAssets[key];
    onUploadedAssetsChange(nextAssets);
  }, [onUploadedAssetsChange, presets, uploadedAssets]);

  if (presets.length === 0) {
    return (
      <div className="rounded-xl border p-6 text-center text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
        Add printer presets first, then manage image assets here.
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Asset paths come from <strong>Printer Presets</strong>. Upload here only replaces the file/preview for that path.
      </div>

      {groupedByFamily.map(([family, items]) => (
        <div key={family} className="rounded-xl border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
            {family}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-2">
            {items.map(({ index, preset }) => {
              const key = getPresetAssetUploadKey(preset, index);
              const uploaded = uploadedAssets[key];
              return (
                <div
                  key={key}
                  className="rounded-lg border p-2.5 flex flex-col gap-2"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                      {[preset.manufacturer, preset.name].filter(Boolean).join(' ').trim() || `Preset ${index + 1}`}
                    </div>
                    {uploaded && (
                      <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                        {uploaded.file.name}
                      </div>
                    )}
                  </div>

                  <div className="flex items-stretch gap-2.5">
                    <PrinterAssetPreview
                      alt={`${preset.manufacturer} ${preset.name}`.trim() || `Preset ${index + 1}`}
                      uploadedPreviewUrl={uploaded?.previewUrl}
                      pathValue={preset.imageAssetPath}
                      previewContext={previewContext}
                    />

                    <div className="min-w-0 flex-1 min-h-[88px] flex flex-col">
                      <div className="text-[11px] font-mono truncate" style={{ color: 'var(--text-muted)' }} title={preset.imageAssetPath || 'No asset path set in Printer Presets'}>
                        {preset.imageAssetPath || 'No asset path set in Printer Presets'}
                      </div>

                      <div className="mt-auto pt-2 flex items-center gap-1.5">
                        <label className="ui-button ui-button-secondary !h-8 !px-2.5 text-[11px] inline-flex items-center cursor-pointer">
                        Upload
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            handleUpload(index, file);
                            event.currentTarget.value = '';
                          }}
                        />
                        </label>
                        <button
                          type="button"
                          onClick={() => clearUpload(index)}
                          className="ui-button ui-button-secondary !h-8 !px-2.5 text-[11px]"
                          style={{ color: uploaded ? 'color-mix(in srgb, var(--danger), var(--text-strong) 22%)' : 'var(--text-muted)' }}
                          disabled={!uploaded}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Material Template Editor ─────────────────────────────────────────────────

type MaterialTemplateEditorProps = {
  template: MaterialTemplateDraft;
  targetOptions: PresetTargetOption[];
  onChange: (next: MaterialTemplateDraft) => void;
  onDelete: () => void;
  hideHeader?: boolean;
};

function MaterialTemplateEditor({ template, targetOptions, onChange, onDelete, hideHeader = false }: MaterialTemplateEditorProps) {
  type EditorTab = { id: string; title: string; kind: 'meta' | 'format'; formatTabId?: string };

  const selectedTarget = React.useMemo(
    () => targetOptions.find((option) => option.presetId === template.targetPresetId) ?? null,
    [targetOptions, template.targetPresetId],
  );

  const resolvedOutputFormat = normalizeOutputFormatKey(selectedTarget?.outputFormat ?? '');
  const resolvedSettingsMode = selectedTarget?.settingsMode?.trim().toLowerCase() || undefined;
  const localSettingsAdapter = React.useMemo(
    () => (resolvedOutputFormat ? getProfileLocalMaterialSettingsAdapter(resolvedOutputFormat, resolvedSettingsMode) : null),
    [resolvedOutputFormat, resolvedSettingsMode],
  );

  const editorTabs = React.useMemo<EditorTab[]>(() => {
    const tabs: EditorTab[] = [{ id: 'meta', title: 'Meta', kind: 'meta' }];
    if (!localSettingsAdapter || localSettingsAdapter.fields.length === 0) {
      return tabs;
    }

    const declared = [...(localSettingsAdapter.tabs ?? [])]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    if (declared.length > 0) {
      declared.forEach((tab) => {
        tabs.push({
          id: `format:${tab.id}`,
          title: tab.title,
          kind: 'format',
          formatTabId: tab.id,
        });
      });
      return tabs;
    }

    tabs.push({
      id: 'format:local',
      title: localSettingsAdapter.displayName ?? 'Format Settings',
      kind: 'format',
      formatTabId: 'local',
    });
    return tabs;
  }, [localSettingsAdapter]);

  const [activeEditorTabId, setActiveEditorTabId] = React.useState<string>('meta');

  React.useEffect(() => {
    if (!editorTabs.some((tab) => tab.id === activeEditorTabId)) {
      setActiveEditorTabId(editorTabs[0]?.id ?? 'meta');
    }
  }, [activeEditorTabId, editorTabs]);

  const activeEditorTab = React.useMemo(
    () => editorTabs.find((tab) => tab.id === activeEditorTabId) ?? editorTabs[0] ?? { id: 'meta', title: 'Meta', kind: 'meta' as const },
    [activeEditorTabId, editorTabs],
  );
  const useReplacementMetaOnly = Boolean(localSettingsAdapter?.replacesDefaultMaterialSettings);
  const [targetQuery, setTargetQuery] = React.useState('');
  const [isTargetSuggestionsOpen, setIsTargetSuggestionsOpen] = React.useState(false);

  React.useEffect(() => {
    setTargetQuery(selectedTarget?.label ?? '');
  }, [selectedTarget?.label, template.targetPresetId]);

  const filteredTargetOptions = React.useMemo(() => {
    const query = targetQuery.trim().toLowerCase();
    if (!query) return targetOptions.slice(0, 12);

    return targetOptions
      .filter((option) => {
        const haystack = `${option.label} ${option.presetId} ${option.manufacturer} ${option.description}`.toLowerCase();
        return haystack.includes(query);
      })
      .slice(0, 12);
  }, [targetOptions, targetQuery]);

  const label = template.draft.brand || template.draft.name
    ? [template.draft.brand, template.draft.name].filter(Boolean).join(' — ')
    : 'Material Template';

  return (
    <div className="rounded-xl border p-3 h-full min-h-0 flex flex-col gap-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
      {!hideHeader && (
        <div className="flex items-center justify-between gap-2">
          <span className="ui-meta font-semibold uppercase tracking-wide">{label}</span>
          <button type="button" onClick={onDelete} className="ui-button ui-button-ghost !h-7 !w-7 !p-0 flex items-center justify-center" aria-label="Remove material">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="rounded-lg border px-2 py-1.5 space-y-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="flex items-center justify-between gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <div className="font-semibold uppercase tracking-wide">Target</div>
          {selectedTarget?.outputFormat && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), black 4%)' }}>
              {normalizeOutputFormatKey(selectedTarget.outputFormat) || selectedTarget.outputFormat}
            </span>
          )}
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          <input
            value={targetQuery}
            placeholder="Search machines…"
            onFocus={() => setIsTargetSuggestionsOpen(true)}
            onBlur={() => {
              // defer close so click handlers can run
              window.setTimeout(() => setIsTargetSuggestionsOpen(false), 120);
            }}
            onChange={(event) => {
              setTargetQuery(event.target.value);
              if (!isTargetSuggestionsOpen) setIsTargetSuggestionsOpen(true);
            }}
            className="ui-input w-full h-[32px] text-xs"
            style={{ paddingLeft: '2rem', paddingRight: '0.625rem' }}
          />

          {isTargetSuggestionsOpen && (
            <div
              className="absolute left-0 right-0 top-[calc(100%+0.375rem)] z-30 rounded-lg border overflow-hidden"
              style={{
                borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 55%)',
                background: 'color-mix(in srgb, var(--surface-0), var(--surface-1) 32%)',
                boxShadow: '0 14px 34px rgba(0,0,0,0.38), 0 0 0 1px color-mix(in srgb, var(--accent-secondary), transparent 72%) inset',
              }}
            >
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange({ ...template, targetPresetId: '' });
                  setTargetQuery('');
                  setIsTargetSuggestionsOpen(false);
                }}
                className="w-full text-left px-2.5 py-2 text-[11px] border-b"
                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'color-mix(in srgb, var(--surface-2), transparent 10%)' }}
              >
                — clear target selection —
              </button>

              {filteredTargetOptions.length === 0 ? (
                <div className="px-2.5 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  No machines match your search.
                </div>
              ) : (
                <div className="max-h-56 overflow-y-auto custom-scrollbar">
                  {filteredTargetOptions.map((option) => {
                    const active = option.presetId === template.targetPresetId;
                    return (
                      <button
                        key={option.presetId}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          onChange({ ...template, targetPresetId: option.presetId });
                          setTargetQuery(option.label);
                          setIsTargetSuggestionsOpen(false);
                        }}
                        className="w-full text-left px-2.5 py-2 border-b last:border-b-0"
                        style={active
                          ? {
                            borderColor: 'var(--border-subtle)',
                            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 88%)',
                          }
                          : {
                            borderColor: 'var(--border-subtle)',
                            background: 'transparent',
                          }}
                      >
                        <div className="text-xs font-medium truncate" style={{ color: active ? 'var(--accent-secondary)' : 'var(--text-strong)' }}>
                          {option.label}
                        </div>
                        <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                          {option.presetId}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="flex items-center gap-1.5 flex-wrap">
          {editorTabs.map((tab) => {
            const active = tab.id === activeEditorTab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveEditorTabId(tab.id)}
                className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-[11px] rounded-md"
                style={active
                  ? ACCENT_SECONDARY_BUTTON_STYLE_90
                  : { color: 'var(--text-muted)' }}
              >
                {tab.title}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1">
        {activeEditorTab.kind === 'meta' ? (
          useReplacementMetaOnly ? (
            <MaterialProfileIdentitySection
              draft={template.draft}
              onChange={(next) => {
                const resolved = typeof next === 'function' ? next(template.draft) : next;
                onChange({ ...template, draft: resolved });
              }}
            />
          ) : (
            <MaterialProfileFormSections
              draft={template.draft}
              onChange={(next) => {
                const resolved = typeof next === 'function' ? next(template.draft) : next;
                onChange({ ...template, draft: resolved });
              }}
            />
          )
        ) : (resolvedOutputFormat && localSettingsAdapter && localSettingsAdapter.fields.length > 0 && activeEditorTab.formatTabId) ? (
          <PluginLocalMaterialSettingsSections
            outputFormat={resolvedOutputFormat}
            settingsMode={resolvedSettingsMode}
            adapter={localSettingsAdapter}
            localSettingsByOutput={template.localSettingsByOutput}
            onChange={(next) => {
              const resolved = typeof next === 'function' ? next(template.localSettingsByOutput) : next;
              onChange({ ...template, localSettingsByOutput: resolved });
            }}
            activeTabId={activeEditorTab.formatTabId}
            onActiveTabChange={() => {}}
            showTabBar={false}
            replacementMode
          />
        ) : (
          <div className="py-3 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            {resolvedOutputFormat
              ? (
                <>
                  No format-specific settings are registered for{' '}
                  <code className="font-mono">{resolvedOutputFormat}</code>.
                </>
              )
              : 'Pick a printer preset to edit format-specific material settings.'}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Step: Materials ──────────────────────────────────────────────────────────

type StepMaterialsProps = { templates: MaterialTemplateDraft[]; onChange: (next: MaterialTemplateDraft[]) => void };

function StepMaterials({ templates, onChange }: StepMaterialsProps) {
  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [expandedMaterialGroups, setExpandedMaterialGroups] = React.useState<Set<string>>(() => new Set());
  const [expandedManufacturerFolders, setExpandedManufacturerFolders] = React.useState<Set<string>>(() => new Set());
  const [pendingDeleteMaterialIndex, setPendingDeleteMaterialIndex] = React.useState<number | null>(null);

  const targetOptions = React.useMemo<PresetTargetOption[]>(() => {
    return buildTargetOptionsFromAvailablePresets();
  }, [profileState]);

  const targetOptionById = React.useMemo(() => {
    const next = new Map<string, PresetTargetOption>();
    targetOptions.forEach((option) => {
      next.set(option.presetId, option);
    });
    return next;
  }, [targetOptions]);

  const hasInvalidPresetSelection = templates.some((template) => !template.targetPresetId.trim());

  const clampedIndex = templates.length === 0 ? -1 : Math.min(selectedIndex, templates.length - 1);

  const groupedMaterials = React.useMemo(() => {
    const groups = new Map<string, { index: number; template: MaterialTemplateDraft }[]>();
    templates.forEach((template, index) => {
      const materialLabel = template.draft.name.trim() || 'New Material';
      if (!groups.has(materialLabel)) groups.set(materialLabel, []);
      groups.get(materialLabel)?.push({ index, template });
    });

    return Array.from(groups.entries())
      .map(([materialLabel, members]) => {
        const manufacturerGroups = new Map<string, { index: number; template: MaterialTemplateDraft }[]>();
        members.forEach((member) => {
          const target = targetOptionById.get(member.template.targetPresetId);
          const manufacturer = target?.manufacturer?.trim() || 'Unassigned';
          if (!manufacturerGroups.has(manufacturer)) manufacturerGroups.set(manufacturer, []);
          manufacturerGroups.get(manufacturer)?.push(member);
        });

        return {
          materialLabel,
          manufacturerGroups: Array.from(manufacturerGroups.entries())
            .map(([manufacturer, manufacturerMembers]) => ({
              manufacturer,
              members: [...manufacturerMembers].sort((a, b) => {
                const aOption = targetOptionById.get(a.template.targetPresetId);
                const bOption = targetOptionById.get(b.template.targetPresetId);
                const aLabel = aOption?.label ?? 'Select printer';
                const bLabel = bOption?.label ?? 'Select printer';
                return aLabel.localeCompare(bLabel);
              }),
            }))
            .sort((a, b) => a.manufacturer.localeCompare(b.manufacturer)),
        };
      })
      .sort((a, b) => a.materialLabel.localeCompare(b.materialLabel));
  }, [targetOptionById, templates]);

  const toggleMaterialGroup = React.useCallback((materialLabel: string) => {
    setExpandedMaterialGroups((previous) => {
      const next = new Set(previous);
      if (next.has(materialLabel)) {
        next.delete(materialLabel);
      } else {
        next.add(materialLabel);
      }
      return next;
    });
  }, []);

  const toggleManufacturerFolder = React.useCallback((folderKey: string) => {
    setExpandedManufacturerFolders((previous) => {
      const next = new Set(previous);
      if (next.has(folderKey)) {
        next.delete(folderKey);
      } else {
        next.add(folderKey);
      }
      return next;
    });
  }, []);

  const addTemplate = React.useCallback(() => {
    const next = [...templates, createDefaultMaterialTemplateDraft()];
    onChange(next);
    setSelectedIndex(next.length - 1);
  }, [onChange, templates]);

  const addPrinterVariantFromTemplate = React.useCallback((index: number) => {
    const source = templates[index];
    if (!source) return;
    const next = [...templates, {
      draft: { ...source.draft },
      localSettingsByOutput: {},
      targetPresetId: '',
    }];
    onChange(next);
    setSelectedIndex(next.length - 1);
  }, [onChange, templates]);

  const deleteMaterialTemplate = React.useCallback((index: number) => {
    const next = templates.filter((_, i) => i !== index);
    onChange(next);
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, next.length - 1)));
  }, [onChange, templates]);

  const requestDeleteMaterialTemplate = React.useCallback((index: number) => {
    setPendingDeleteMaterialIndex(index);
  }, []);

  const cancelDeleteMaterialTemplate = React.useCallback(() => {
    setPendingDeleteMaterialIndex(null);
  }, []);

  const confirmDeleteMaterialTemplate = React.useCallback(() => {
    if (pendingDeleteMaterialIndex === null) return;
    deleteMaterialTemplate(pendingDeleteMaterialIndex);
    setPendingDeleteMaterialIndex(null);
  }, [deleteMaterialTemplate, pendingDeleteMaterialIndex]);

  const pendingDeleteMaterialLabel = React.useMemo(() => {
    if (pendingDeleteMaterialIndex === null) return 'this material preset';
    const template = templates[pendingDeleteMaterialIndex];
    return template
      ? [template.draft.brand, template.draft.name].filter(Boolean).join(' — ') || 'this material preset'
      : 'this material preset';
  }, [pendingDeleteMaterialIndex, templates]);

  const selectedTemplate = clampedIndex >= 0 ? templates[clampedIndex] : null;
  const selectedTarget = selectedTemplate ? targetOptionById.get(selectedTemplate.targetPresetId) ?? null : null;

  return (
    <>
      <div className="h-full min-h-0 flex flex-col gap-2.5">
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Define material presets as printer-bound variants. Same resin can have multiple entries targeting different printer presets.
      </div>

      {hasInvalidPresetSelection && (
        <div className="rounded-xl border p-3 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
          One or more material variants are missing a target printer preset.
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-3">
        <div
          className="flex flex-col rounded-xl border overflow-hidden shrink-0"
          style={{
            width: 236,
            borderColor: 'var(--border-subtle)',
            background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-1), transparent 10%), color-mix(in srgb, var(--accent-secondary), var(--surface-1) 97%))',
          }}
        >
          <div className="px-3 py-2 border-b flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Material Presets
            </span>
            <span className="text-[10px] tabular-nums px-1.5 py-0.5 rounded-md border" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              {templates.length}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {templates.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-center" style={{ color: 'var(--text-muted)' }}>
                No material presets yet.
              </div>
            ) : (
              groupedMaterials.map(({ materialLabel, manufacturerGroups }) => {
                const isMaterialExpanded = expandedMaterialGroups.has(materialLabel);
                const materialVariantCount = manufacturerGroups.reduce((total, group) => total + group.members.length, 0);

                return (
                  <div key={materialLabel} className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                    <button
                      type="button"
                      onClick={() => toggleMaterialGroup(materialLabel)}
                      className="w-full px-3 py-1.5 text-left flex items-center justify-between gap-2"
                      style={{ background: 'color-mix(in srgb, var(--surface-1), black 8%)' }}
                      aria-expanded={isMaterialExpanded}
                      aria-label={`${materialLabel} material profile`}
                    >
                      <span className="min-w-0 inline-flex items-center gap-1.5">
                        <ChevronDown
                          className="h-3.5 w-3.5 shrink-0 transition-transform"
                          style={{ color: 'var(--text-muted)', transform: isMaterialExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                        />
                        <span className="text-[10px] font-semibold uppercase tracking-widest truncate" style={{ color: 'var(--text-muted)' }}>
                          {materialLabel}
                        </span>
                      </span>
                      <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{materialVariantCount}</span>
                    </button>

                    {isMaterialExpanded && (
                      <div
                        className="relative"
                        style={{ background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 96%)' }}
                      >
                        <span
                          className="pointer-events-none absolute left-3 top-0 bottom-0 w-px"
                          style={{ background: 'color-mix(in srgb, var(--accent-secondary), transparent 74%)' }}
                        />

                        {manufacturerGroups.map(({ manufacturer, members }) => {
                          const folderKey = `${materialLabel}::${manufacturer}`;
                          const isExpanded = expandedManufacturerFolders.has(folderKey);

                          return (
                            <div key={folderKey} className="border-t pl-2" style={{ borderColor: 'var(--border-subtle)' }}>
                              <button
                                type="button"
                                onClick={() => toggleManufacturerFolder(folderKey)}
                                className="w-full pl-4 pr-3 py-1.5 text-left flex items-center justify-between gap-2"
                                style={{ background: 'color-mix(in srgb, var(--surface-1), transparent 18%)' }}
                                aria-expanded={isExpanded}
                                aria-label={`${manufacturer} printer folder`}
                              >
                                <span className="min-w-0 inline-flex items-center gap-1.5">
                                  <span
                                    className="h-px w-2 shrink-0"
                                    style={{ background: 'color-mix(in srgb, var(--accent-secondary), transparent 62%)' }}
                                  />
                                  <ChevronDown
                                    className="h-3.5 w-3.5 shrink-0 transition-transform"
                                    style={{ color: 'var(--text-muted)', transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                                  />
                                  <span className="text-[10px] font-semibold uppercase tracking-wide truncate" style={{ color: 'var(--text-muted)' }}>
                                    {manufacturer}
                                  </span>
                                </span>
                                <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{members.length}</span>
                              </button>

                              {isExpanded && members.map(({ index, template }) => {
                                const target = targetOptionById.get(template.targetPresetId);
                                const label = target?.label || 'Select printer';
                                const active = index === clampedIndex;

                                return (
                                  <div
                                    key={index}
                                    className="group grid grid-cols-[4px_minmax(0,1fr)_auto] items-center gap-2 border-t ml-5"
                                    style={{
                                      borderColor: 'var(--border-subtle)',
                                      background: active
                                        ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 86%)'
                                        : 'color-mix(in srgb, var(--surface-1), transparent 22%)',
                                    }}
                                  >
                                    <span className="h-full" style={{ background: active ? 'var(--accent-secondary)' : 'color-mix(in srgb, var(--accent-secondary), transparent 82%)' }} />
                                    <button type="button" onClick={() => setSelectedIndex(index)} className="min-w-0 text-left py-2">
                                      <div className="text-xs font-medium truncate leading-tight" style={{ color: active ? 'var(--accent-secondary)' : 'var(--text-strong)' }}>
                                        {label}
                                      </div>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => requestDeleteMaterialTemplate(index)}
                                      className="ui-button ui-button-ghost !h-5 !w-5 !p-0 inline-flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mr-2"
                                      aria-label="Delete material"
                                      title="Delete material"
                                    >
                                      <Trash2 className="h-3 w-3" style={{ color: 'color-mix(in srgb, var(--danger), var(--text-strong) 22%)' }} />
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="p-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <button
              type="button"
              onClick={addTemplate}
              className="ui-button ui-button-secondary w-full !h-8 text-[11px] flex items-center justify-center gap-1.5"
              style={ACCENT_SECONDARY_BUTTON_STYLE_92}
              title="Add Material"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Material
            </button>
          </div>
        </div>

        <div className="flex-1 min-w-0 h-full">
          {selectedTemplate === null ? (
            <div className="rounded-xl border h-full flex items-center justify-center text-xs" style={{ minHeight: 220, borderColor: 'var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
              Add a material preset to get started.
            </div>
          ) : (
            <div className="rounded-xl border p-3 h-full min-h-0 flex flex-col" style={{ borderColor: 'var(--border-subtle)', background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-2), transparent 4%), var(--surface-2))' }}>
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                    {[selectedTemplate.draft.brand, selectedTemplate.draft.name].filter(Boolean).join(' — ') || 'New Material'}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    <span className="px-1.5 py-0.5 rounded border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                      {selectedTarget ? selectedTarget.label : 'No printer selected'}
                    </span>
                    <span className="px-1.5 py-0.5 rounded border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                      {selectedTarget?.outputFormat || 'format pending'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => addPrinterVariantFromTemplate(clampedIndex)}
                    className="ui-button ui-button-secondary !h-7 !px-2 text-[11px] flex items-center gap-1.5"
                    style={ACCENT_SECONDARY_BUTTON_STYLE_92}
                    title="Duplicate this material core profile into a new printer variant"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Printer Variant
                  </button>
                  <button
                    type="button"
                    onClick={() => requestDeleteMaterialTemplate(clampedIndex)}
                    className="ui-button ui-button-ghost !h-7 !px-2 text-[11px] flex items-center gap-1.5"
                    style={{ color: 'color-mix(in srgb, var(--danger), var(--text-strong) 22%)', borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 60%)' }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0">
                <MaterialTemplateEditor
                  key={clampedIndex}
                  template={selectedTemplate}
                  targetOptions={targetOptions}
                  hideHeader
                  onChange={(next) => {
                    const updated = [...templates];
                    updated[clampedIndex] = next;
                    onChange(updated);
                  }}
                  onDelete={() => requestDeleteMaterialTemplate(clampedIndex)}
                />
              </div>
            </div>
          )}
        </div>
      </div>
      </div>

      <DeleteConfirmDialog
        isOpen={pendingDeleteMaterialIndex !== null}
        title={`Delete ${pendingDeleteMaterialLabel}?`}
        message="This action cannot be undone."
        confirmLabel="Delete Material"
        onCancel={cancelDeleteMaterialTemplate}
        onConfirm={confirmDeleteMaterialTemplate}
      />
    </>
  );
}

// ─── Step: Export ─────────────────────────────────────────────────────────────

type StepExportProps = {
  jsonContent: string;
  readmeContent: string;
  slug: string;
  printerPresetFiles: PrinterPresetSplitFile[];
  materialPresetFiles: MaterialPresetSplitFile[];
  printerAssetFiles: PrinterAssetExportFile[];
  confirmOverwriteOnSave?: boolean;
};

function StepExport({ jsonContent, readmeContent, slug, printerPresetFiles, materialPresetFiles, printerAssetFiles, confirmOverwriteOnSave = false }: StepExportProps) {
  const [writeStatus, setWriteStatus] = React.useState<{ kind: 'idle' | 'success' | 'error'; message: string }>({ kind: 'idle', message: '' });
  const [isWritingToPluginsDir, setIsWritingToPluginsDir] = React.useState(false);
  const [showOverwriteConfirm, setShowOverwriteConfirm] = React.useState(false);

  const exportFiles = React.useMemo(
    () => [
      { name: 'dragonfruit-plugin.json', content: jsonContent, type: 'application/json' },
      { name: 'README.md', content: readmeContent, type: 'text/markdown;charset=utf-8' },
      ...printerPresetFiles.map((file) => ({
        name: file.relativePath,
        content: file.content,
        type: 'application/json',
      })),
      ...materialPresetFiles.map((file) => ({
        name: file.relativePath,
        content: file.content,
        type: 'application/json',
      })),
    ],
    [jsonContent, materialPresetFiles, printerPresetFiles, readmeContent],
  );

  const hasBinaryAssets = printerAssetFiles.length > 0;
  const isDevRuntime = process.env.NODE_ENV === 'development';
  const isTauriRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const canWriteToPluginsDirectory = isDevRuntime && isTauriRuntime;
  const pluginDir = normalizePluginDirectorySlug(slug || 'my-plugin');
  const destinationBase = '../plugins';

  const destinationPreviewFiles = React.useMemo(() => [
    ...exportFiles.map((file) => `plugins/${pluginDir}/${file.name}`),
    ...printerAssetFiles.map((asset) => `plugins/${pluginDir}/${toPluginAssetFileRelativePath(asset.relativePath)}`),
  ], [exportFiles, pluginDir, printerAssetFiles]);

  const performWriteToPluginsDirectory = async () => {
    if (!canWriteToPluginsDirectory) return;

    setIsWritingToPluginsDir(true);
    setWriteStatus({ kind: 'idle', message: '' });

    try {
      const encoder = new TextEncoder();
      for (const file of exportFiles) {
        const destination = `${destinationBase}/${pluginDir}/${file.name}`;
        await writeBytesToNativePath(destination, encoder.encode(file.content));
      }

      for (const asset of printerAssetFiles) {
        const destination = `${destinationBase}/${pluginDir}/${toPluginAssetFileRelativePath(asset.relativePath)}`;
        const bytes = new Uint8Array(await asset.file.arrayBuffer());
        await writeBytesToNativePath(destination, bytes);
      }

      setWriteStatus({
        kind: 'success',
        message: `Wrote plugin files to plugins/${pluginDir}`,
      });
    } catch (error) {
      setWriteStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Failed writing plugin files into plugins directory.',
      });
    } finally {
      setIsWritingToPluginsDir(false);
    }
  };

  const handleWriteToPluginsDirectory = async () => {
    if (!canWriteToPluginsDirectory) return;
    if (confirmOverwriteOnSave) {
      setShowOverwriteConfirm(true);
      return;
    }
    await performWriteToPluginsDirectory();
  };

  const handleConfirmOverwriteWrite = async () => {
    setShowOverwriteConfirm(false);
    await performWriteToPluginsDirectory();
  };

  return (
    <div className="space-y-3">
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Export previews generated files and can write directly into your local <code className="font-mono">plugins/</code> directory in dev runtime.
      </div>

      {printerPresetFiles.length > 0 && (
        <div className="rounded-xl border p-2.5 space-y-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Generated Printer Files</div>
          <ul className="space-y-0.5">
            {printerPresetFiles.map((file) => (
              <li key={file.relativePath} className="text-xs font-mono" style={{ color: 'var(--text-strong)' }}>
                {file.relativePath}
              </li>
            ))}
          </ul>
        </div>
      )}

      {materialPresetFiles.length > 0 && (
        <div className="rounded-xl border p-2.5 space-y-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Generated Material Files</div>
          <ul className="space-y-0.5">
            {materialPresetFiles.map((file) => (
              <li key={file.relativePath} className="text-xs font-mono" style={{ color: 'var(--text-strong)' }}>
                {file.relativePath}
              </li>
            ))}
          </ul>
        </div>
      )}

      {printerAssetFiles.length > 0 && (
        <div className="rounded-xl border p-2.5 space-y-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Uploaded Asset Files</div>
          <ul className="space-y-0.5">
            {printerAssetFiles.map((file) => (
              <li key={file.relativePath} className="text-xs font-mono" style={{ color: 'var(--text-strong)' }}>
                {normalizeAssetRelativePath(file.relativePath)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {writeStatus.kind !== 'idle' && (
        <div className="text-xs" style={{ color: writeStatus.kind === 'error' ? 'color-mix(in srgb, var(--danger), var(--text-strong) 22%)' : 'color-mix(in srgb, var(--accent-secondary), var(--text-strong) 24%)' }}>
          {writeStatus.message}
        </div>
      )}

      {showOverwriteConfirm && (
        <div
          className="fixed inset-0 z-[130] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowOverwriteConfirm(false);
          }}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Confirm overwrite files"
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center gap-2.5">
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)',
                    background: 'color-mix(in srgb, #d97706, var(--surface-1) 85%)',
                    color: 'color-mix(in srgb, #d97706, var(--text-strong) 20%)',
                  }}
                >
                  <AlertTriangle className="h-4 w-4" />
                </span>
                <div>
                  <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                    Overwrite existing plugin files?
                  </h2>
                  <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    This plugin is loaded in edit mode. Writing will replace existing files.
                  </p>
                </div>
              </div>

              <button
                type="button"
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border transition-colors"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                aria-label="Close overwrite confirmation"
                onClick={() => setShowOverwriteConfirm(false)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Files to overwrite:
              </p>
              <div className="rounded-lg border p-2 max-h-44 overflow-auto" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <ul className="space-y-1">
                  {destinationPreviewFiles.map((file) => (
                    <li key={file} className="text-xs font-mono" style={{ color: 'var(--text-strong)' }}>
                      {file}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                  onClick={() => setShowOverwriteConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs inline-flex items-center gap-1.5"
                  style={ACCENT_SECONDARY_BUTTON_STYLE_92}
                  onClick={() => { void handleConfirmOverwriteWrite(); }}
                >
                  <Archive className="w-3.5 h-3.5" />
                  Overwrite & Write
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <CodeBlock label="dragonfruit-plugin.json" content={jsonContent} />
      <CodeBlock label="README.md" content={readmeContent} />

      {slug && (
        <div className="rounded-xl border p-3 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Next Steps</div>
          <ol className="text-xs space-y-1 list-decimal list-inside" style={{ color: 'var(--text-muted)' }}>
            <li>Use <strong>Write to plugins/</strong> to generate files in your local plugin folder.</li>
            <li>Commit and push your changes to GitHub.</li>
            <li>In DragonFruit: Plugins → Install from GitHub URL → enter your repo URL.</li>
          </ol>
        </div>
      )}

      {canWriteToPluginsDirectory && (
        <div className="pt-1 flex items-center justify-center">
          <button
            type="button"
            onClick={() => { void handleWriteToPluginsDirectory(); }}
            disabled={isWritingToPluginsDir}
            className="ui-button ui-button-secondary !h-8 !px-3 text-xs flex items-center gap-1.5 disabled:opacity-60"
            style={ACCENT_SECONDARY_BUTTON_STYLE_92}
            title="Write files directly into plugins/<slug> in this dev workspace"
          >
            <Archive className="h-3.5 w-3.5" />
            {isWritingToPluginsDir ? 'Writing…' : 'Write to plugins/'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── PluginStudioModal ────────────────────────────────────────────────────────

type PluginStudioModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function PluginStudioModal({ isOpen, onClose }: PluginStudioModalProps) {
  const [meta, setMeta] = React.useState<PluginMeta>({ name: '', slug: '', version: '1.0.0', author: '', githubOwner: '', description: '', homepage: '' });
  const [includesPrinters, setIncludesPrinters] = React.useState(true);
  const [includesMaterials, setIncludesMaterials] = React.useState(true);
  const [printerPresets, setPrinterPresets] = React.useState<PrinterPresetDraft[]>([]);
  const [uploadedPrinterAssets, setUploadedPrinterAssets] = React.useState<Record<string, UploadedPrinterAsset>>({});
  const [assetPreviewContext, setAssetPreviewContext] = React.useState<AssetPreviewContext>({});
  const [materialTemplates, setMaterialTemplates] = React.useState<MaterialTemplateDraft[]>([]);
  const [importedReadmeContent, setImportedReadmeContent] = React.useState<string | null>(null);
  const [isEditingImportedPlugin, setIsEditingImportedPlugin] = React.useState(false);
  const [currentStep, setCurrentStep] = React.useState<StepId>('details');
  const [showExitConfirm, setShowExitConfirm] = React.useState(false);
  const [isLightTheme, setIsLightTheme] = React.useState(false);
  const [isDesktopWindow, setIsDesktopWindow] = React.useState(false);
  const [isDesktopWindowMaximized, setIsDesktopWindowMaximized] = React.useState(false);
  const readmeLoadRunRef = React.useRef(0);
  const wasOpenRef = React.useRef(false);
  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);

  const resetStudioState = React.useCallback(() => {
    setMeta({ name: '', slug: '', version: '1.0.0', author: '', githubOwner: '', description: '', homepage: '' });
    setIncludesPrinters(true);
    setIncludesMaterials(true);
    setPrinterPresets([]);
    setMaterialTemplates([]);
    setImportedReadmeContent(null);
    setIsEditingImportedPlugin(false);
    setCurrentStep('details');
    setShowExitConfirm(false);
    setAssetPreviewContext({});

    setUploadedPrinterAssets((current) => {
      Object.values(current).forEach((asset) => {
        if (asset.previewUrl) URL.revokeObjectURL(asset.previewUrl);
      });
      return {};
    });

    readmeLoadRunRef.current += 1;
  }, []);

  React.useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    resetStudioState();
  }, [isOpen, resetStudioState]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const evaluateTheme = () => {
      const root = document.documentElement;
      const explicitTheme = root.getAttribute('data-theme');
      if (explicitTheme === 'light') {
        setIsLightTheme(true);
        return;
      }
      if (explicitTheme === 'dark') {
        setIsLightTheme(false);
        return;
      }
      setIsLightTheme(window.matchMedia('(prefers-color-scheme: light)').matches);
    };

    evaluateTheme();

    const observer = new MutationObserver(evaluateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handleMediaChange = () => evaluateTheme();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleMediaChange);
    } else {
      mediaQuery.addListener(handleMediaChange);
    }

    return () => {
      observer.disconnect();
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleMediaChange);
      } else {
        mediaQuery.removeListener(handleMediaChange);
      }
    };
  }, []);

  const orderedSteps = React.useMemo((): StepId[] => {
    const steps: StepId[] = ['details', 'content'];
    if (includesPrinters) steps.push('printers', 'assets');
    if (includesMaterials) steps.push('materials');
    steps.push('export', 'repo');
    return steps;
  }, [includesPrinters, includesMaterials]);

  // Keep currentStep in bounds when content toggles remove steps
  React.useEffect(() => {
    if (orderedSteps.includes(currentStep)) return;
    const currentAllIndex = ALL_STEP_IDS.indexOf(currentStep);
    for (let i = currentAllIndex - 1; i >= 0; i--) {
      const candidate = ALL_STEP_IDS[i];
      if (orderedSteps.includes(candidate)) {
        setCurrentStep(candidate);
        return;
      }
    }
    setCurrentStep('details');
  }, [orderedSteps, currentStep]);

  const currentStepIndex = orderedSteps.indexOf(currentStep);
  const incompletePluginDetailFields = React.useMemo(
    () => getIncompletePluginDetailFields(meta, { allowMissingAttribution: isEditingImportedPlugin }),
    [isEditingImportedPlugin, meta],
  );
  const isPluginDetailsComplete = incompletePluginDetailFields.length === 0;
  const hasInvalidMaterialTargets = materialTemplates.some((template) => !template.targetPresetId.trim());
  const canGoBack = currentStepIndex > 0;
  const canGoNext = currentStepIndex < orderedSteps.length - 1
    && !(currentStep === 'details' && !isPluginDetailsComplete)
    && !(currentStep === 'content' && !includesPrinters && !includesMaterials)
    && !(currentStep === 'materials' && hasInvalidMaterialTargets);
  const nextBlockedReason = !canGoNext
    ? currentStep === 'details' && !isPluginDetailsComplete
      ? 'Complete all Plugin Details fields to continue'
      : currentStep === 'content' && !includesPrinters && !includesMaterials
        ? 'Select at least one content type to continue'
        : currentStep === 'materials' && hasInvalidMaterialTargets
          ? 'Select a target printer preset for every material variant'
          : undefined
    : undefined;
  const isLastStep = currentStepIndex === orderedSteps.length - 1;
  const activeStepMeta = STEP_META[currentStep];
  const activeStepColor = activeStepMeta.tone === 'secondary' ? 'var(--accent-secondary)' : 'var(--accent)';
  const ActiveStepIcon = activeStepMeta.icon;
  const isFillHeightStep = currentStep === 'details' || currentStep === 'materials' || currentStep === 'printers';

  const requestExitStudio = React.useCallback(() => {
    setShowExitConfirm(true);
  }, []);

  const cancelExitStudio = React.useCallback(() => {
    setShowExitConfirm(false);
  }, []);

  const confirmExitStudio = React.useCallback(() => {
    setShowExitConfirm(false);
    onClose();
  }, [onClose]);

  React.useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      if (showExitConfirm) {
        setShowExitConfirm(false);
        return;
      }
      setShowExitConfirm(true);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen, showExitConfirm]);

  React.useEffect(() => {
    if (!isOpen) return;
    if (typeof window === 'undefined') return;

    let cancelled = false;

    const hydrateDesktopWindowState = async () => {
      const isLikelyDesktopRuntime =
        window.location.protocol === 'tauri:'
        || window.location.protocol === 'file:'
        || window.location.hostname === 'tauri.localhost'
        || typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';

      if (!isLikelyDesktopRuntime) {
        if (!cancelled) {
          setIsDesktopWindow(false);
          setIsDesktopWindowMaximized(false);
        }
        return;
      }

      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        const maximized = await currentWindow.isMaximized();
        if (!cancelled) {
          setIsDesktopWindow(true);
          setIsDesktopWindowMaximized(maximized);
        }
      } catch {
        if (!cancelled) {
          setIsDesktopWindow(false);
          setIsDesktopWindowMaximized(false);
        }
      }
    };

    void hydrateDesktopWindowState();

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const handleDesktopWindowMinimize = React.useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().minimize();
    } catch {
      // no-op in web runtime or restricted capability mode
    }
  }, []);

  const handleDesktopWindowToggleMaximize = React.useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const currentWindow = getCurrentWindow();
      await currentWindow.toggleMaximize();
      const maximized = await currentWindow.isMaximized();
      setIsDesktopWindowMaximized(maximized);
    } catch {
      // no-op in web runtime or restricted capability mode
    }
  }, []);

  const handleDesktopWindowClose = React.useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch {
      // no-op in web runtime or restricted capability mode
    }
  }, []);

  const hydrateReadmeFromImport = React.useCallback(async (options: { homepage?: string; sourceUrl?: string; pluginId?: string }) => {
    const runId = readmeLoadRunRef.current + 1;
    readmeLoadRunRef.current = runId;
    setImportedReadmeContent(null);

    const loaded = await tryLoadExistingReadme(options);
    if (readmeLoadRunRef.current !== runId) return;
    if (!loaded) return;
    setImportedReadmeContent(loaded);
  }, []);

  const applyManifestToStudio = React.useCallback((manifestLike: Record<string, unknown>, options?: { sourceUrl?: string }): ImportManifestResult => {
    const incomingId = asString(manifestLike.id);
    const incomingSlug = parseSlugFromPluginId(incomingId);
    const incomingHomepage = asString(manifestLike.homepage);
    const homepageOwner = parseGithubRepoUrl(incomingHomepage)?.owner ?? '';

    const nextMeta: PluginMeta = {
      ...meta,
      name: asString(manifestLike.name, meta.name),
      slug: incomingSlug || meta.slug,
      version: asString(manifestLike.version, meta.version),
      author: asString(manifestLike.author, meta.author),
      githubOwner: normalizeGithubOwner(homepageOwner || meta.githubOwner),
      description: asString(manifestLike.description, meta.description),
      homepage: incomingHomepage || meta.homepage,
    };

    const incomingPrinterPresets = Array.isArray(manifestLike.printerPresets) ? manifestLike.printerPresets : [];
    const incomingMaterialPresets = Array.isArray(manifestLike.materialPresets)
      ? manifestLike.materialPresets
      : Array.isArray(manifestLike.materialTemplates)
        ? manifestLike.materialTemplates
        : [];

    const nextPrinterPresets = incomingPrinterPresets.map(parsePrinterPresetDraft);
    const nextMaterialTemplates = incomingMaterialPresets.flatMap(parseMaterialTemplateDrafts);

    setMeta(nextMeta);
    setIncludesPrinters(nextPrinterPresets.length > 0);
    setIncludesMaterials(nextMaterialTemplates.length > 0);

    setAssetPreviewContext({
      pluginId: incomingId,
      pluginSlug: incomingSlug,
      sourceUrl: options?.sourceUrl,
      homepage: incomingHomepage,
    });
    setPrinterPresets(nextPrinterPresets);
    setUploadedPrinterAssets({});
    setMaterialTemplates(nextMaterialTemplates);
    setCurrentStep('details');
    setIsEditingImportedPlugin(true);
    void hydrateReadmeFromImport({ homepage: nextMeta.homepage, sourceUrl: options?.sourceUrl, pluginId: incomingId });

    return {
      ok: true,
      message: `Loaded plugin (${nextPrinterPresets.length} printer preset${nextPrinterPresets.length === 1 ? '' : 's'}, ${nextMaterialTemplates.length} material preset${nextMaterialTemplates.length === 1 ? '' : 's'}).`,
    };
  }, [hydrateReadmeFromImport, meta]);

  const handleImportManifest = React.useCallback((rawText: string): ImportManifestResult => {
    const text = rawText.trim();
    if (!text) {
      return { ok: false, message: 'Paste a dragonfruit-plugin.json payload first.' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, message: 'Invalid JSON. Please verify the manifest and try again.' };
    }

    if (!isRecord(parsed)) {
      return { ok: false, message: 'Manifest root must be a JSON object.' };
    }

    return applyManifestToStudio(parsed);
  }, [applyManifestToStudio]);

  const installedPluginsForEditing = React.useMemo(() => {
    const plugins = getInstalledPlugins();
    return plugins
      .filter((plugin) => isSimplePluginManifestLike(plugin.manifest as unknown as Record<string, unknown>))
      .map((plugin) => ({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        sourceLabel: plugin.source === 'builtin' ? 'Built-in' : 'Installed',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [profileState]);

  const handleImportInstalledPlugin = React.useCallback((pluginId: string): ImportManifestResult => {
    const targetId = pluginId.trim();
    if (!targetId) {
      return { ok: false, message: 'Select an installed plugin first.' };
    }

    const plugin = getInstalledPlugins().find((entry) => entry.manifest.id === targetId);
    if (!plugin) {
      return { ok: false, message: 'Selected plugin is no longer available.' };
    }

    if (!isSimplePluginManifestLike(plugin.manifest as unknown as Record<string, unknown>)) {
      return { ok: false, message: 'Only simple plugins can be edited in this studio.' };
    }

    const manifestLike = plugin.manifest as unknown as Record<string, unknown>;
    const result = applyManifestToStudio(manifestLike, { sourceUrl: plugin.sourceUrl });
    if (!result.ok) return result;

    return {
      ok: true,
      message: `Loaded installed plugin: ${plugin.manifest.name} v${plugin.manifest.version}.`,
    };
  }, [applyManifestToStudio]);

  const targetOptions = React.useMemo<PresetTargetOption[]>(() => {
    return buildTargetOptionsFromAvailablePresets();
  }, [profileState]);

  const targetOptionById = React.useMemo(() => {
    const next = new Map<string, PresetTargetOption>();
    targetOptions.forEach((option) => {
      next.set(option.presetId, option);
    });
    return next;
  }, [targetOptions]);

  const materialPresetSplitFiles = React.useMemo(
    () => (includesMaterials ? buildMaterialPresetSplitFiles(materialTemplates, targetOptionById) : []),
    [includesMaterials, materialTemplates, targetOptionById],
  );

  const jsonContent = React.useMemo(
    () => buildPluginJson(meta, includesPrinters, includesMaterials, printerPresets, materialPresetSplitFiles),
    [meta, includesPrinters, includesMaterials, printerPresets, materialPresetSplitFiles],
  );
  const printerPresetSplitFiles = React.useMemo(
    () => (includesPrinters ? buildPrinterPresetSplitFiles(printerPresets) : []),
    [includesPrinters, printerPresets],
  );
  const printerAssetExportFiles = React.useMemo((): PrinterAssetExportFile[] => {
    if (!includesPrinters) return [];

    return printerPresets.flatMap((preset, index) => {
      const relativePath = preset.imageAssetPath.trim();
      if (!relativePath) return [];
      const key = getPresetAssetUploadKey(preset, index);
      const upload = uploadedPrinterAssets[key];
      if (!upload?.file) return [];
      return [{ relativePath, file: upload.file }];
    });
  }, [includesPrinters, printerPresets, uploadedPrinterAssets]);
  const readmeContent = React.useMemo(
    () => importedReadmeContent ?? buildReadmeTemplate(meta),
    [importedReadmeContent, meta],
  );

  React.useEffect(() => {
    if (isEditingImportedPlugin) return;
    setAssetPreviewContext((current) => ({
      ...current,
      pluginSlug: meta.slug.trim(),
      homepage: meta.homepage.trim(),
    }));
  }, [isEditingImportedPlugin, meta.homepage, meta.slug]);

  React.useEffect(() => {
    if (isOpen) return;
    Object.values(uploadedPrinterAssets).forEach((asset) => {
      if (asset.previewUrl) URL.revokeObjectURL(asset.previewUrl);
    });
  }, [isOpen, uploadedPrinterAssets]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center ui-modal-backdrop-enter"
      style={{ background: 'var(--surface-0)' }}
    >
      <div
        className="w-full h-full flex flex-col ui-modal-panel-enter"
        style={{
          background: 'var(--surface-0)',
        }}
      >
        <div
          className="grid grid-cols-[minmax(260px,1fr)_auto_minmax(260px,1fr)] items-center gap-3 px-4 py-2.5"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className="inline-flex h-8 w-8 items-center justify-center rounded-md"
              style={{ background: 'transparent' }}
            >
              <img
                src="/dragonfruit_assets/branding/simple_icon.svg"
                alt="DragonFruit"
                className="h-6 w-6 object-contain"
                draggable={false}
              />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                DragonFruit
              </div>
              <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                Plugin authoring mode
              </div>
            </div>
          </div>

          <div className="justify-self-center inline-flex items-center gap-2">
            <FileText className="h-3.5 w-3.5" style={{ color: 'var(--accent-secondary)' }} />
            <span className="text-[13px] font-semibold tracking-[0.01em]" style={{ color: 'var(--text-strong)' }}>
              Plugin Creation Studio
            </span>
          </div>

          <div className="flex items-center gap-2 justify-self-end">
            {isDesktopWindow && (
              <div className="flex items-center gap-1" aria-label="Window controls">
                <button
                  type="button"
                  onClick={handleDesktopWindowMinimize}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors"
                  style={isLightTheme ? {
                    borderColor: 'color-mix(in srgb, #c8920a, var(--border-subtle) 35%)',
                    background: 'color-mix(in srgb, #c8920a, var(--surface-1) 50%)',
                    color: 'var(--text-strong)',
                  } : {
                    borderColor: 'color-mix(in srgb, #f4bf4f, var(--border-subtle) 55%)',
                    background: 'color-mix(in srgb, #f4bf4f, var(--surface-1) 86%)',
                    color: 'color-mix(in srgb, #f4bf4f, var(--text-strong) 16%)',
                  }}
                  title="Minimize"
                  aria-label="Minimize window"
                >
                  <Minimize2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleDesktopWindowToggleMaximize}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors"
                  style={isLightTheme ? {
                    borderColor: 'color-mix(in srgb, #1a7a3a, var(--border-subtle) 35%)',
                    background: 'color-mix(in srgb, #1a7a3a, var(--surface-1) 50%)',
                    color: 'var(--text-strong)',
                  } : {
                    borderColor: 'color-mix(in srgb, #40c463, var(--border-subtle) 55%)',
                    background: 'color-mix(in srgb, #40c463, var(--surface-1) 86%)',
                    color: 'color-mix(in srgb, #40c463, var(--text-strong) 16%)',
                  }}
                  title={isDesktopWindowMaximized ? 'Restore' : 'Maximize'}
                  aria-label={isDesktopWindowMaximized ? 'Restore window' : 'Maximize window'}
                >
                  {isDesktopWindowMaximized ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleDesktopWindowClose}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors"
                  style={isLightTheme ? {
                    borderColor: 'color-mix(in srgb, #c0160a, var(--border-subtle) 35%)',
                    background: 'color-mix(in srgb, #c0160a, var(--surface-1) 50%)',
                    color: 'var(--text-strong)',
                  } : {
                    borderColor: 'color-mix(in srgb, #ff6b6b, var(--border-subtle) 55%)',
                    background: 'color-mix(in srgb, #ff6b6b, var(--surface-1) 88%)',
                    color: 'color-mix(in srgb, #ff6b6b, var(--text-strong) 18%)',
                  }}
                  title="Close"
                  aria-label="Close window"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 p-3 lg:p-4">
          <div
            className="mx-auto h-full w-full max-w-[1680px] min-h-0 flex overflow-hidden rounded-xl border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-0)',
            }}
          >
            <div
              className="w-[16.5rem] xl:w-[18rem] p-2.5 shrink-0"
              style={{
                borderRight: '1px solid var(--border-subtle)',
                background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-1), transparent 6%), color-mix(in srgb, var(--accent-secondary), var(--surface-1) 96%))',
              }}
            >
              <div className="h-full flex flex-col">
                <div className="space-y-1.5">
                  {orderedSteps.map((stepId, index) => {
                    const meta = STEP_META[stepId];
                    const Icon = meta.icon;
                    const active = stepId === currentStep;
                    const done = index < currentStepIndex;
                    const blockedByDetails = !isPluginDetailsComplete && stepId !== 'details';
                    const stepColor = meta.tone === 'secondary' ? 'var(--accent-secondary)' : 'var(--accent)';

                    return (
                      <button
                        key={stepId}
                        type="button"
                        onClick={() => {
                          if (blockedByDetails) return;
                          setCurrentStep(stepId);
                        }}
                        disabled={blockedByDetails}
                        title={blockedByDetails ? 'Complete Plugin Details fields to unlock this step' : undefined}
                        className="w-full rounded-lg border px-3 py-2.5 text-left transition-all duration-150 disabled:opacity-45 disabled:cursor-not-allowed"
                        style={active
                          ? {
                            borderColor: `color-mix(in srgb, ${stepColor}, var(--border-subtle) 35%)`,
                            background: `color-mix(in srgb, ${stepColor}, var(--surface-0) 84%)`,
                            boxShadow: `0 0 0 1px color-mix(in srgb, ${stepColor}, transparent 76%) inset`,
                          }
                          : {
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--surface-1)',
                          }}
                      >
                        <div className="flex items-start gap-2.5">
                          <span
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border"
                            style={{
                              borderColor: active
                                ? `color-mix(in srgb, ${stepColor}, var(--border-subtle) 30%)`
                                : 'var(--border-subtle)',
                              background: active
                                ? `color-mix(in srgb, ${stepColor}, var(--surface-1) 82%)`
                                : 'var(--surface-2)',
                            }}
                          >
                            {done ? (
                              <Check className="h-3.5 w-3.5" style={{ color: active ? stepColor : 'var(--text-muted)' }} />
                            ) : (
                              <Icon className="h-3.5 w-3.5" style={{ color: active ? stepColor : 'var(--text-muted)' }} />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                              {meta.label}
                            </span>
                            <span className="block text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                              {meta.description}
                            </span>
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className={isFillHeightStep ? 'flex-1 min-h-0 overflow-hidden p-2.5' : 'flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2.5'}>
              <div className={isFillHeightStep ? 'w-full h-full min-h-0 flex flex-col' : 'w-full'}>
                <div className="mb-3 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
                  <div className="flex items-center gap-2">
                    <ActiveStepIcon className="h-4 w-4" style={{ color: activeStepColor }} />
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{activeStepMeta.label}</h3>
                  </div>
                  <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>{activeStepMeta.description}</p>
                </div>

                <div key={currentStep} className={isFillHeightStep ? 'animate-[settingsTabIn_180ms_ease-out] h-full min-h-0 flex flex-col' : 'animate-[settingsTabIn_180ms_ease-out]'}>
                  {currentStep === 'details' && (
                    <StepDetails
                      meta={meta}
                      onChange={setMeta}
                      onImportManifest={handleImportManifest}
                      installedPlugins={installedPluginsForEditing}
                      onImportInstalledPlugin={handleImportInstalledPlugin}
                      incompleteFields={incompletePluginDetailFields}
                    />
                  )}
                  {currentStep === 'repo' && <StepRepo meta={meta} />}
                  {currentStep === 'content' && (
                    <StepContent
                      includesPrinters={includesPrinters}
                      setIncludesPrinters={setIncludesPrinters}
                      includesMaterials={includesMaterials}
                      setIncludesMaterials={setIncludesMaterials}
                    />
                  )}
                  {currentStep === 'printers' && <StepPrinters presets={printerPresets} onChange={setPrinterPresets} />}
                  {currentStep === 'assets' && (
                    <StepAssets
                      presets={printerPresets}
                      onPresetsChange={setPrinterPresets}
                      uploadedAssets={uploadedPrinterAssets}
                      onUploadedAssetsChange={setUploadedPrinterAssets}
                      previewContext={assetPreviewContext}
                    />
                  )}
                  {currentStep === 'materials' && <StepMaterials templates={materialTemplates} onChange={setMaterialTemplates} />}
                  {currentStep === 'export' && (
                    <StepExport
                      jsonContent={jsonContent}
                      readmeContent={readmeContent}
                      slug={meta.slug}
                      printerPresetFiles={printerPresetSplitFiles}
                      materialPresetFiles={materialPresetSplitFiles}
                      printerAssetFiles={printerAssetExportFiles}
                      confirmOverwriteOnSave={isEditingImportedPlugin}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t flex items-center justify-between gap-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={requestExitStudio}
              className="ui-button ui-button-secondary !h-8 !px-3 text-xs shrink-0"
              style={{
                borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 55%)',
                color: 'color-mix(in srgb, var(--danger), var(--text-strong) 22%)',
              }}
            >
              Exit Plugin Creation Studio
            </button>

            <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
              {!isPluginDetailsComplete
                ? `Complete Plugin Details to continue (${incompletePluginDetailFields.length} field${incompletePluginDetailFields.length === 1 ? '' : 's'} remaining).`
                : 'Material presets can target all printers or specific preset IDs across built-in and loaded plugins.'}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {currentStepIndex + 1} / {orderedSteps.length}
            </span>

            <button
              type="button"
              onClick={() => { if (canGoBack) setCurrentStep(orderedSteps[currentStepIndex - 1]); }}
              disabled={!canGoBack}
              className="ui-button ui-button-secondary !h-8 !px-3 text-xs flex items-center gap-1.5 disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Back
            </button>

            {isLastStep ? (
              <button type="button" onClick={requestExitStudio} className="ui-button ui-button-secondary !h-8 !px-3 text-xs">
                Close
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { if (canGoNext) setCurrentStep(orderedSteps[currentStepIndex + 1]); }}
                disabled={!canGoNext}
                title={nextBlockedReason}
                className="ui-button ui-button-primary !h-8 !px-3 text-xs flex items-center gap-1.5 disabled:opacity-40"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {showExitConfirm && (
          <div
            className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                cancelExitStudio();
              }
            }}
          >
            <div
              className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
              style={{
                background: 'var(--surface-0)',
                borderColor: 'var(--border-subtle)',
                boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
              }}
              role="dialog"
              aria-modal="true"
              aria-label="Exit Plugin Creation Studio"
            >
              <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="flex items-center gap-2.5">
                  <span
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
                    style={{
                      borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)',
                      background: 'color-mix(in srgb, #d97706, var(--surface-1) 85%)',
                      color: 'color-mix(in srgb, #d97706, var(--text-strong) 20%)',
                    }}
                  >
                    <AlertTriangle className="h-4 w-4" />
                  </span>
                  <div>
                    <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                      Are you sure you're done with everything?
                    </h2>
                    <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Any unsaved progress in this session will be lost.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md border transition-colors"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-1)',
                    color: 'var(--text-muted)',
                  }}
                  aria-label="Close exit confirmation"
                  onClick={cancelExitStudio}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-4 space-y-3">
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  If you want to keep the generated manifest, copy or download it from the Export step before exiting.
                </p>

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                    onClick={cancelExitStudio}
                  >
                    Stay in Studio
                  </button>
                  <button
                    type="button"
                    className="ui-button !h-9 px-3 text-xs"
                    style={{
                      borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 45%)',
                      background: 'color-mix(in srgb, var(--danger), var(--surface-1) 86%)',
                      color: 'color-mix(in srgb, var(--danger), var(--text-strong) 22%)',
                    }}
                    onClick={confirmExitStudio}
                  >
                    Exit Studio
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
