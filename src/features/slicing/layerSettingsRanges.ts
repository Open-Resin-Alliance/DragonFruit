export const LAYER_SETTING_FIELDS = [
  'exposureSec',
  'lightOffDelaySec',
  'waitTimeBeforeCureSec',
  'waitTimeAfterCureSec',
  'waitTimeAfterLiftSec',
  'liftHeightMm',
  'liftHeight2Mm',
  'liftSpeedMmMin',
  'liftSpeed2MmMin',
  'retractHeightMm',
  'retractHeight2Mm',
  'retractSpeedMmMin',
  'retractSpeed2MmMin',
  'lightPwm',
] as const;

export type LayerSettingField = typeof LAYER_SETTING_FIELDS[number];
export type LayerPrintSettingsPatch = Partial<Record<LayerSettingField, number>>;
export type LayerSettingsRange = {
  id: string;
  startLayer: number;
  endLayer: number;
  settings: LayerPrintSettingsPatch;
};
export type LayerSettingsSegment = {
  startLayer: number;
  endLayer: number;
  settings: LayerPrintSettingsPatch;
  rangeId: string;
};

const MAX_LAYER = 4294967295;
const MAX_F32 = 3.4028234663852886e38;
const RANGE_KEYS = ['id', 'startLayer', 'endLayer', 'settings'] as const;
const FIELD_KEYS = new Set<string>(LAYER_SETTING_FIELDS);

function invalid(reason: string): never {
  throw new Error(`Invalid layer settings range: ${reason}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Validate the entire collection and return owned ranges with canonical patch order. */
export function parseLayerSettingsRanges(input: unknown): LayerSettingsRange[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) invalid('expected an array');
  const ids = new Set<string>();
  const result: LayerSettingsRange[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const value: unknown = input[index];
    const label = `range ${index}`;
    if (!isObject(value)) invalid(`${label} must be an object`);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !RANGE_KEYS.some((allowed) => allowed === key)) {
        invalid(`${label} has unknown key ${String(key)}`);
      }
    }
    for (const key of RANGE_KEYS) {
      if (!hasOwn(value, key)) invalid(`${label} must have own ${key}`);
    }
    const { id, startLayer, endLayer, settings } = value;
    if (typeof id !== 'string' || id.length === 0) invalid(`${label} id must be a nonempty string`);
    if (ids.has(id)) invalid(`duplicate id ${id}`);
    ids.add(id);
    if (typeof startLayer !== 'number' || !Number.isInteger(startLayer) || startLayer < 1 || startLayer > MAX_LAYER) {
      invalid(`${label} startLayer must be an integer in 1..4294967295`);
    }
    if (typeof endLayer !== 'number' || !Number.isInteger(endLayer) || endLayer < 1 || endLayer > MAX_LAYER) {
      invalid(`${label} endLayer must be an integer in 1..4294967295`);
    }
    if (startLayer > endLayer) invalid(`${label} startLayer must not exceed endLayer`);
    if (!isObject(settings)) invalid(`${label} settings must be an object`);
    const keys = Reflect.ownKeys(settings);
    for (const key of keys) {
      if (typeof key !== 'string' || !FIELD_KEYS.has(key)) {
        invalid(`${label} settings has unknown key ${String(key)}`);
      }
    }
    if (keys.length === 0) invalid(`${label} settings must supply at least one field`);
    const patch: LayerPrintSettingsPatch = {};
    for (const field of LAYER_SETTING_FIELDS) {
      if (!hasOwn(settings, field)) continue;
      const numeric = settings[field];
      if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric < 0 || numeric > MAX_F32) {
        invalid(`${label} ${field} must be a finite number in 0..f32::MAX`);
      }
      if (field === 'lightPwm' && (!Number.isInteger(numeric) || numeric > 255)) {
        invalid(`${label} lightPwm must be an integer in 0..255`);
      }
      patch[field] = numeric === 0 ? 0 : numeric;
    }
    result.push({ id, startLayer, endLayer, settings: patch });
  }
  return result;
}

/** Index heap: original narrower span wins, then later original array position. */
class RangeHeap {
  private readonly entries: number[] = [];

  constructor(private readonly spans: readonly number[]) {}

  private precedes(left: number, right: number): boolean {
    return this.spans[left] < this.spans[right]
      || (this.spans[left] === this.spans[right] && left > right);
  }

  push(index: number): void {
    let position = this.entries.length;
    this.entries.push(index);
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (!this.precedes(index, this.entries[parent])) break;
      this.entries[position] = this.entries[parent];
      position = parent;
    }
    this.entries[position] = index;
  }

  winner(active: readonly boolean[]): number | undefined {
    while (this.entries.length > 0 && !active[this.entries[0]]) {
      const last = this.entries.pop()!;
      if (this.entries.length === 0) break;
      let position = 0;
      while (position * 2 + 1 < this.entries.length) {
        let child = position * 2 + 1;
        if (child + 1 < this.entries.length && this.precedes(this.entries[child + 1], this.entries[child])) {
          child += 1;
        }
        if (!this.precedes(this.entries[child], last)) break;
        this.entries[position] = this.entries[child];
        position = child;
      }
      this.entries[position] = last;
    }
    return this.entries[0];
  }
}

function samePatch(left: LayerPrintSettingsPatch, right: LayerPrintSettingsPatch): boolean {
  return LAYER_SETTING_FIELDS.every((field) => left[field] === right[field]);
}

/** Compile only covered intervals, never an array proportional to the print height. */
export function compileLayerSettingsRanges(
  ranges: readonly LayerSettingsRange[],
  totalLayers: number,
): LayerSettingsSegment[] {
  const owned = parseLayerSettingsRanges(ranges);
  if (!Number.isInteger(totalLayers) || totalLayers < 0 || totalLayers > MAX_LAYER) {
    invalid('totalLayers must be an integer in 0..4294967295');
  }
  if (totalLayers === 0) return [];
  const spans = owned.map((range) => range.endLayer - range.startLayer + 1);
  const display = new RangeHeap(spans);
  const fields = LAYER_SETTING_FIELDS.map(() => new RangeHeap(spans));
  const active = owned.map(() => false);
  const events: { layer: number; index: number; starting: boolean }[] = [];
  owned.forEach((range, index) => {
    if (range.startLayer > totalLayers) return;
    events.push({ layer: range.startLayer, index, starting: true });
    // u32::MAX + 1 is still an exact safe integer in JavaScript.
    events.push({ layer: Math.min(range.endLayer, totalLayers) + 1, index, starting: false });
  });
  events.sort((left, right) => left.layer - right.layer || Number(left.starting) - Number(right.starting));
  const segments: LayerSettingsSegment[] = [];
  let cursor = 0;
  while (cursor < events.length) {
    const startLayer = events[cursor].layer;
    do {
      const event = events[cursor];
      active[event.index] = event.starting;
      if (event.starting) {
        display.push(event.index);
        LAYER_SETTING_FIELDS.forEach((field, fieldIndex) => {
          if (hasOwn(owned[event.index].settings, field)) fields[fieldIndex].push(event.index);
        });
      }
      cursor += 1;
    } while (cursor < events.length && events[cursor].layer === startLayer);
    if (cursor === events.length) break;
    const winner = display.winner(active);
    if (winner === undefined) continue;
    const endLayer = events[cursor].layer - 1;
    const settings: LayerPrintSettingsPatch = {};
    LAYER_SETTING_FIELDS.forEach((field, fieldIndex) => {
      const supplier = fields[fieldIndex].winner(active);
      if (supplier !== undefined) settings[field] = owned[supplier].settings[field]!;
    });
    const rangeId = owned[winner].id;
    const previous = segments[segments.length - 1];
    if (previous && previous.endLayer + 1 === startLayer && previous.rangeId === rangeId && samePatch(previous.settings, settings)) {
      previous.endLayer = endLayer;
    } else {
      segments.push({ startLayer, endLayer, settings, rangeId });
    }
  }
  return segments;
}

/** Printing identity excludes display ids but preserves original priority/order. */
export function fingerprintLayerSettingsRanges(ranges: readonly LayerSettingsRange[]): string {
  return JSON.stringify(parseLayerSettingsRanges(ranges).map(({ startLayer, endLayer, settings }) => ({
    startLayer,
    endLayer,
    settings,
  })));
}

/** Check every original range, including shadowed and beyond-EOF fields. */
export function findUnsupportedLayerSetting(
  ranges: readonly LayerSettingsRange[],
  supportedFields: readonly LayerSettingField[],
): { rangeId: string; field: LayerSettingField } | null {
  const owned = parseLayerSettingsRanges(ranges);
  const supported = new Set(supportedFields);
  for (const range of owned) {
    for (const field of LAYER_SETTING_FIELDS) {
      if (hasOwn(range.settings, field) && !supported.has(field)) return { rangeId: range.id, field };
    }
  }
  return null;
}
