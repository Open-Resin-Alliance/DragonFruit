import type {
  RemoteMaterialAdvancedSection,
  RemoteMaterialBasicSection,
  RemoteMaterialPrimaryField,
  RemoteMaterialProcessValues,
} from '@/features/plugins/complexPluginContracts';

export type RemoteMaterialProfile = {
  id: string;
  name: string;
  locked: boolean;
  meta: Record<string, unknown>;
};

export type RemoteMaterialEditDraft = Record<string, string>;

export type RemoteMaterialSectionEntry = readonly [string, string];

export type RemoteMaterialResolvedSection = {
  id: string;
  title: string;
  entries: RemoteMaterialSectionEntry[];
};

export function formatRemoteMaterialFieldLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .trim();
}

export function isLikelyNumericRemoteMaterialField(key: string, value: string): boolean {
  const normalizedKey = key.toLowerCase();
  if (Number.isFinite(Number(value))) return true;
  return (
    normalizedKey.includes('time')
    || normalizedKey.includes('layer')
    || normalizedKey.includes('speed')
    || normalizedKey.includes('height')
    || normalizedKey.includes('distance')
    || normalizedKey.includes('exposure')
    || normalizedKey.includes('lift')
    || normalizedKey.includes('wait')
    || normalizedKey.includes('depth')
  );
}

export function buildRemoteMaterialChips(
  material: RemoteMaterialProfile,
  resolveMaterialProcessValues: (meta: Record<string, unknown>) => RemoteMaterialProcessValues,
): string[] {
  const processValues = resolveMaterialProcessValues(material.meta ?? {});
  const parts: string[] = [];

  if (processValues.bottomLayerCount != null) {
    parts.push(`Burn-In ${processValues.bottomLayerCount}L`);
  }

  if (processValues.bottomExposureSec != null) {
    parts.push(`Burn-In ${processValues.bottomExposureSec.toFixed(1)}s`);
  }

  if (processValues.normalExposureSec != null) {
    parts.push(`Cure ${processValues.normalExposureSec.toFixed(1)}s`);
  }

  return parts;
}

export function buildSortedRemoteMaterialDraftEntries(
  draft: RemoteMaterialEditDraft,
  primaryFields: RemoteMaterialPrimaryField[],
): RemoteMaterialSectionEntry[] {
  const entries = Object.entries(draft) as Array<[string, string]>;
  const primaryOrder = new Map<string, number>();
  primaryFields.forEach((field, index) => {
    primaryOrder.set(field.key, index);
  });

  return entries.sort(([keyA], [keyB]) => {
    const indexA = primaryOrder.get(keyA);
    const indexB = primaryOrder.get(keyB);

    const isPrimaryA = indexA != null;
    const isPrimaryB = indexB != null;

    if (isPrimaryA && isPrimaryB) return (indexA as number) - (indexB as number);
    if (isPrimaryA) return -1;
    if (isPrimaryB) return 1;
    return keyA.localeCompare(keyB);
  });
}

export function buildBasicRemoteMaterialSections(
  draft: RemoteMaterialEditDraft,
  primaryFields: RemoteMaterialPrimaryField[],
  basicSections: RemoteMaterialBasicSection[],
): RemoteMaterialResolvedSection[] {
  const entryMap = new Map<string, string>();
  primaryFields.forEach((field) => {
    const value = draft[field.key];
    if (typeof value === 'string') {
      entryMap.set(field.key, value);
    }
  });

  return basicSections
    .map((section) => ({
      ...section,
      entries: section.keys
        .map((key) => [key, entryMap.get(key)] as const)
        .filter(([, value]) => typeof value === 'string') as RemoteMaterialSectionEntry[],
    }))
    .filter((section) => section.entries.length > 0);
}

export function buildAdvancedRemoteMaterialSections(
  sortedDraftEntries: RemoteMaterialSectionEntry[],
  primaryFields: RemoteMaterialPrimaryField[],
  advancedSections: RemoteMaterialAdvancedSection[],
  resolveAdvancedSectionId: (fieldKey: string) => string,
): RemoteMaterialResolvedSection[] {
  const primaryFieldKeys = new Set(primaryFields.map((field) => field.key));
  const advancedEntries = sortedDraftEntries
    .filter(([key]) => !primaryFieldKeys.has(key));

  const sectionTitleById = new Map<string, string>([
    ...advancedSections.map((section) => [section.id, section.title] as const),
    ['other', 'Other Advanced Controls'] as const,
  ]);

  const grouped = new Map<string, RemoteMaterialSectionEntry[]>();
  for (const entry of advancedEntries) {
    const sectionId = resolveAdvancedSectionId(entry[0]);
    const current = grouped.get(sectionId);
    if (current) {
      current.push(entry);
    } else {
      grouped.set(sectionId, [entry]);
    }
  }

  const orderedIds = [...advancedSections.map((section) => section.id), 'other'];
  return orderedIds
    .map((id) => ({
      id,
      title: sectionTitleById.get(id) ?? 'Advanced',
      entries: grouped.get(id) ?? [],
    }))
    .filter((section) => section.entries.length > 0);
}
