import type {
  RemoteMaterialAdvancedSection,
  RemoteMaterialBasicSection,
  RemoteMaterialFieldKind,
  RemoteMaterialFieldOption,
  RemoteMaterialPrimaryField,
  RemoteMaterialProcessValues,
  RemoteMaterialSettingsAdapter,
} from './complexPluginContracts';

const FIELD_KINDS: Record<RemoteMaterialFieldKind, true> = {
  number: true,
  integer: true,
  text: true,
  boolean: true,
  select: true,
};

const MAX_FIELDS = 128;
const MAX_SECTIONS = 32;

export type DeclaredRemoteMaterials = {
  primaryFields: RemoteMaterialPrimaryField[];
  basicSections: RemoteMaterialBasicSection[];
  advancedSections: RemoteMaterialAdvancedSection[];
};

const text = (value: unknown, max: number): string => (
  typeof value === 'string' ? value.trim().slice(0, max) : ''
);

const stringList = (value: unknown, max: number, maxLength: number): string[] => (
  Array.isArray(value)
    ? value.slice(0, max).map((entry) => text(entry, maxLength)).filter((entry) => entry.length > 0)
    : []
);

function sanitizeOptions(value: unknown): RemoteMaterialFieldOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .slice(0, 64)
    .map((entry) => {
      const option = (entry ?? {}) as Record<string, unknown>;
      const optionValue = text(option.value, 120);
      return optionValue ? { value: optionValue, label: text(option.label, 120) || optionValue } : null;
    })
    .filter((option): option is RemoteMaterialFieldOption => option !== null);
  return options.length > 0 ? options : undefined;
}

function sanitizeField(input: unknown): RemoteMaterialPrimaryField | null {
  const value = (input ?? {}) as Record<string, unknown>;
  const key = text(value.key, 64);
  if (!key) return null;

  const rawDefault = value.defaultValue;
  const defaultValue = typeof rawDefault === 'number' || typeof rawDefault === 'string' || typeof rawDefault === 'boolean'
    ? rawDefault
    : '';
  const kind = text(value.kind, 16);

  return {
    key,
    label: text(value.label, 120) || key,
    aliases: stringList(value.aliases, 16, 64),
    defaultValue,
    ...(kind && FIELD_KINDS[kind as RemoteMaterialFieldKind] ? { kind: kind as RemoteMaterialFieldKind } : {}),
    ...(text(value.description, 240) ? { description: text(value.description, 240) } : {}),
    ...(sanitizeOptions(value.options) ? { options: sanitizeOptions(value.options) } : {}),
  };
}

function sanitizeBasicSections(value: unknown): RemoteMaterialBasicSection[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_SECTIONS)
    .map((entry) => {
      const section = (entry ?? {}) as Record<string, unknown>;
      const id = text(section.id, 64);
      if (!id) return null;
      return { id, title: text(section.title, 120) || id, keys: stringList(section.keys, 128, 64) };
    })
    .filter((section): section is RemoteMaterialBasicSection => section !== null);
}

function sanitizeAdvancedSections(value: unknown): RemoteMaterialAdvancedSection[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_SECTIONS)
    .map((entry) => {
      const section = (entry ?? {}) as Record<string, unknown>;
      const id = text(section.id, 64);
      if (!id) return null;
      return { id, title: text(section.title, 120) || id, keywords: stringList(section.keywords, 32, 64) };
    })
    .filter((section): section is RemoteMaterialAdvancedSection => section !== null);
}

/**
 * Validate the on-device material schema a package declares. The shapes are the
 * compiled plugins' own (`RemoteMaterialPrimaryField` and friends), so one dialog
 * renders both; anything the dialog cannot render strictly is dropped.
 */
export function sanitizeDeclaredRemoteMaterials(source: unknown): DeclaredRemoteMaterials | null {
  if (!source || typeof source !== 'object') return null;
  const value = source as Record<string, unknown>;

  const primaryFields = Array.isArray(value.primaryFields)
    ? value.primaryFields.slice(0, MAX_FIELDS)
      .map(sanitizeField)
      .filter((field): field is RemoteMaterialPrimaryField => field !== null)
    : [];
  const unique: RemoteMaterialPrimaryField[] = [];
  const seen = new Set<string>();
  for (const field of primaryFields) {
    if (seen.has(field.key)) continue;
    seen.add(field.key);
    unique.push(field);
  }
  if (unique.length === 0) return null;

  return {
    primaryFields: unique,
    basicSections: sanitizeBasicSections(value.basicSections),
    advancedSections: sanitizeAdvancedSections(value.advancedSections),
  };
}

const numeric = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * The generic half of a declared mode's material adapter: a draft is read from the
 * material `meta` by field key (or alias), and sent back as the same keys. A
 * backend that needs a different wire shape does its own mapping behind
 * `materialsEdit`.
 */
export function buildDeclaredRemoteMaterialsAdapter(
  declared: DeclaredRemoteMaterials,
): RemoteMaterialSettingsAdapter {
  const fieldsByKey = new Map(declared.primaryFields.map((field) => [field.key, field] as const));

  return {
    primaryEditFields: declared.primaryFields,
    basicSections: declared.basicSections,
    advancedSections: declared.advancedSections,
    resolveEditDraftFromMeta: (meta) => {
      const draft: Record<string, string> = {};
      for (const field of declared.primaryFields) {
        const source = [field.key, ...(field.aliases ?? [])]
          .find((key) => meta[key] !== undefined && meta[key] !== null);
        const value = source ? meta[source] : field.defaultValue;
        draft[field.key] = value === undefined || value === null ? '' : String(value);
      }
      return draft;
    },
    resolveMaterialProcessValues: (meta): RemoteMaterialProcessValues => ({
      layerHeightMm: numeric(meta.layerHeightMm),
      normalExposureSec: numeric(meta.normalExposureSec),
      bottomExposureSec: numeric(meta.bottomExposureSec),
      bottomLayerCount: numeric(meta.bottomLayerCount),
    }),
    denormalizeEditDraftForBackend: (draft) => ({ ...draft }),
    resolveAdvancedSectionId: (fieldKey) => {
      const match = declared.advancedSections.find((section) => (
        section.keywords.some((keyword) => fieldKey.toLowerCase().includes(keyword.toLowerCase()))
      ));
      return match?.id ?? '';
    },
    getFieldHelpText: (fieldKey) => fieldsByKey.get(fieldKey)?.description ?? '',
    isDynamicWaitEnabled: () => false,
  };
}
