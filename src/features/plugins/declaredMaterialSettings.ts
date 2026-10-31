import type {
  LocalMaterialCardSchema,
  LocalMaterialFieldKind,
  LocalMaterialFieldOption,
  LocalMaterialFieldSchema,
  LocalMaterialSectionSchema,
  LocalMaterialTabSchema,
  MaterialSettingsSource,
  PluginLocalMaterialSettingsAdapterContract,
} from './complexPluginContracts';
import { resolveDifferentialMaterialSettings } from './resolveDifferentialSettings';

const FIELD_KINDS: Record<LocalMaterialFieldKind, true> = {
  number: true,
  integer: true,
  text: true,
  boolean: true,
  select: true,
  spacer: true,
};

const MAX_FIELDS = 512;
const MAX_TABS = 32;
const MAX_SECTIONS = 64;
const MAX_CARDS = 128;
const MAX_OPTIONS = 64;

const text = (value: unknown, max: number): string => (
  typeof value === 'string' ? value.trim().slice(0, max) : ''
);

const number = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

function sanitizeOptions(value: unknown): LocalMaterialFieldOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .slice(0, MAX_OPTIONS)
    .map((entry) => {
      const option = (entry ?? {}) as Record<string, unknown>;
      const optionValue = text(option.value, 120);
      const label = text(option.label, 120) || optionValue;
      return optionValue ? { value: optionValue, label } : null;
    })
    .filter((option): option is LocalMaterialFieldOption => option !== null);
  return options.length > 0 ? options : undefined;
}

function sanitizeField(input: unknown): LocalMaterialFieldSchema | null {
  const value = (input ?? {}) as Record<string, unknown>;
  const key = text(value.key, 64);
  const kind = text(value.kind, 16);
  if (!key || FIELD_KINDS[kind as LocalMaterialFieldKind] !== true) return null;

  const fallback = value.defaultValue;
  const defaultValue = typeof fallback === 'number' || typeof fallback === 'string' || typeof fallback === 'boolean'
    ? fallback
    : undefined;
  if (defaultValue === undefined) return null;

  const field: LocalMaterialFieldSchema = {
    key,
    // The guard above narrowed this to a known kind.
    kind: kind as LocalMaterialFieldKind,
    label: text(value.label, 120) || key,
    defaultValue,
  };

  const tag = text(value.tag, 32);
  if (tag) field.tag = tag;
  const color = text(value.color, 32);
  if (color) field.color = color;
  const splitWithKey = text(value.splitWithKey, 64);
  if (splitWithKey) field.splitWithKey = splitWithKey;
  const description = text(value.description, 240);
  if (description) field.description = description;
  const metadataPath = text(value.metadataPath, 160);
  if (metadataPath) field.metadataPath = metadataPath;
  const rowKey = text(value.rowKey, 64);
  if (rowKey) field.rowKey = rowKey;

  for (const bound of ['min', 'max', 'step'] as const) {
    const parsed = number(value[bound]);
    if (parsed !== undefined) field[bound] = parsed;
  }
  const rowWeight = number(value.rowWeight);
  if (rowWeight !== undefined) field.rowWeight = rowWeight;
  if (typeof value.disabled === 'boolean') field.disabled = value.disabled;

  const options = sanitizeOptions(value.options);
  if (options) field.options = options;

  const placement = (value.placement ?? {}) as Record<string, unknown>;
  const tabId = text(placement.tabId, 64);
  const sectionId = text(placement.sectionId, 64);
  const cardId = text(placement.cardId, 64);
  const order = number(placement.order);
  if (tabId || sectionId || cardId || order !== undefined) {
    field.placement = {
      ...(tabId ? { tabId } : {}),
      ...(sectionId ? { sectionId } : {}),
      ...(cardId ? { cardId } : {}),
      ...(order !== undefined ? { order } : {}),
    };
  }

  return field;
}

function sanitizeTabs(value: unknown): LocalMaterialTabSchema[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tabs = value
    .slice(0, MAX_TABS)
    .map((entry) => {
      const tab = (entry ?? {}) as Record<string, unknown>;
      const id = text(tab.id, 64);
      if (!id) return null;
      const order = number(tab.order);
      const description = text(tab.description, 240);
      return {
        id,
        title: text(tab.title, 120) || id,
        ...(order !== undefined ? { order } : {}),
        ...(description ? { description } : {}),
      } satisfies LocalMaterialTabSchema;
    })
    .filter((tab): tab is LocalMaterialTabSchema => tab !== null);
  return tabs.length > 0 ? tabs : undefined;
}

function sanitizeSections(value: unknown): LocalMaterialSectionSchema[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sections = value
    .slice(0, MAX_SECTIONS)
    .map((entry) => {
      const section = (entry ?? {}) as Record<string, unknown>;
      const id = text(section.id, 64);
      if (!id) return null;
      const tabId = text(section.tabId, 64);
      const order = number(section.order);
      const description = text(section.description, 240);
      return {
        id,
        title: text(section.title, 120) || id,
        ...(tabId ? { tabId } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(description ? { description } : {}),
      } satisfies LocalMaterialSectionSchema;
    })
    .filter((section): section is LocalMaterialSectionSchema => section !== null);
  return sections.length > 0 ? sections : undefined;
}

function sanitizeCards(value: unknown): LocalMaterialCardSchema[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cards = value
    .slice(0, MAX_CARDS)
    .map((entry) => {
      const card = (entry ?? {}) as Record<string, unknown>;
      const id = text(card.id, 64);
      if (!id) return null;
      const tabId = text(card.tabId, 64);
      const sectionId = text(card.sectionId, 64);
      const order = number(card.order);
      const description = text(card.description, 240);
      return {
        id,
        title: text(card.title, 120) || id,
        ...(tabId ? { tabId } : {}),
        ...(sectionId ? { sectionId } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(description ? { description } : {}),
      } satisfies LocalMaterialCardSchema;
    })
    .filter((card): card is LocalMaterialCardSchema => card !== null);
  return cards.length > 0 ? cards : undefined;
}

/**
 * Validate a package-declared material pane schema. The schema is the one compiled
 * plugins use (`LocalMaterialSettingsAdapterContract`), carried as data; this
 * function is the only place it is trusted, so it drops anything the renderer
 * would have to guess about — unknown field kinds, missing keys, non-scalar
 * defaults.
 *
 * `modeSources` is the raw map for the same output format, used to resolve a
 * differential object (`$inherit`). A missing base or a cycle yields `null`: a
 * settings pane that cannot be resolved must not half-render.
 */
export function sanitizeDeclaredMaterialSettings(
  outputFormat: string,
  source: unknown,
  modeSources?: Record<string, unknown>,
): PluginLocalMaterialSettingsAdapterContract | null {
  if (!source || typeof source !== 'object') return null;

  let resolved: unknown = source;
  if (modeSources && typeof (source as MaterialSettingsSource) === 'object' && '$inherit' in (source as object)) {
    try {
      resolved = resolveDifferentialMaterialSettings(
        source as MaterialSettingsSource,
        modeSources as Record<string, MaterialSettingsSource>,
      );
    } catch {
      return null;
    }
  }

  const value = (resolved ?? {}) as Record<string, unknown>;
  const fields = Array.isArray(value.fields)
    ? value.fields.slice(0, MAX_FIELDS).map(sanitizeField).filter((field): field is LocalMaterialFieldSchema => field !== null)
    : [];
  if (fields.length === 0) return null;

  const displayName = text(value.displayName, 120);
  const tabs = sanitizeTabs(value.tabs);
  const sections = sanitizeSections(value.sections);
  const cards = sanitizeCards(value.cards);

  return {
    outputFormat,
    ...(displayName ? { displayName } : {}),
    ...(value.replacesDefaultMaterialSettings === true ? { replacesDefaultMaterialSettings: true } : {}),
    ...(tabs ? { tabs } : {}),
    ...(sections ? { sections } : {}),
    ...(cards ? { cards } : {}),
    fields,
  };
}
