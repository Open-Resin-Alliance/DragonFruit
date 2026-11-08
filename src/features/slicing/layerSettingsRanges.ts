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
export type LayerNumberSettingsRange = {
  id: string;
  unit?: undefined;
  startLayer: number;
  endLayer: number;
  settings: LayerPrintSettingsPatch;
};
export type MillimeterSettingsRange = {
  id: string;
  unit: 'mm';
  startMm: number;
  endMm: number;
  settings: LayerPrintSettingsPatch;
};
export type LayerSettingsRange = LayerNumberSettingsRange | MillimeterSettingsRange;
export type LayerSettingsSegment = {
  startLayer: number;
  endLayer: number;
  settings: LayerPrintSettingsPatch;
  rangeId: string;
};

const MAX_LAYER = 4294967295;
const MAX_F32 = 3.4028234663852886e38;
const LAYER_RANGE_KEYS: readonly string[] = ['id', 'startLayer', 'endLayer', 'settings'];
const MM_RANGE_KEYS: readonly string[] = ['id', 'unit', 'startMm', 'endMm', 'settings'];
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
    const millimeters = hasOwn(value, 'unit');
    if (millimeters && value.unit !== 'mm') invalid(`${label} unit must be mm when supplied`);
    const rangeKeys = millimeters ? MM_RANGE_KEYS : LAYER_RANGE_KEYS;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !rangeKeys.includes(key)) {
        invalid(`${label} has unknown key ${String(key)}`);
      }
    }
    for (const key of rangeKeys) {
      if (!hasOwn(value, key)) invalid(`${label} must have own ${key}`);
    }
    const { id, settings } = value;
    if (typeof id !== 'string' || id.length === 0) invalid(`${label} id must be a nonempty string`);
    if (ids.has(id)) invalid(`duplicate id ${id}`);
    ids.add(id);
    let bounds: { unit: 'mm'; startMm: number; endMm: number } | { startLayer: number; endLayer: number };
    if (millimeters) {
      const { startMm, endMm } = value;
      if (typeof startMm !== 'number' || !Number.isFinite(startMm) || startMm < 0 || startMm > MAX_F32) {
        invalid(`${label} startMm must be a finite number in 0..f32::MAX`);
      }
      if (typeof endMm !== 'number' || !Number.isFinite(endMm) || endMm < 0 || endMm > MAX_F32) {
        invalid(`${label} endMm must be a finite number in 0..f32::MAX`);
      }
      if (startMm > endMm) invalid(`${label} startMm must not exceed endMm`);
      bounds = { unit: 'mm', startMm: startMm === 0 ? 0 : startMm, endMm: endMm === 0 ? 0 : endMm };
    } else {
      const { startLayer, endLayer } = value;
      if (typeof startLayer !== 'number' || !Number.isInteger(startLayer) || startLayer < 1 || startLayer > MAX_LAYER) {
        invalid(`${label} startLayer must be an integer in 1..4294967295`);
      }
      if (typeof endLayer !== 'number' || !Number.isInteger(endLayer) || endLayer < 1 || endLayer > MAX_LAYER) {
        invalid(`${label} endLayer must be an integer in 1..4294967295`);
      }
      if (startLayer > endLayer) invalid(`${label} startLayer must not exceed endLayer`);
      bounds = { startLayer, endLayer };
    }
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
    result.push({ id, ...bounds, settings: patch });
  }
  return result;
}

/** Resolve inclusive printed-layer end heights without clipping or changing saved bounds. */
export function resolveLayerSettingsRangeBounds(
  range: LayerSettingsRange,
  layerHeightMm?: number,
): { startLayer: number; endLayer: number } | null {
  if (range.unit !== 'mm') return { startLayer: range.startLayer, endLayer: range.endLayer };
  if (typeof layerHeightMm !== 'number' || !Number.isFinite(layerHeightMm)
    || layerHeightMm <= 0 || !Number.isFinite(Math.fround(layerHeightMm)) || Math.fround(layerHeightMm) === 0) {
    invalid('layerHeightMm must be a finite positive f32-representable number for mm ranges');
  }
  // Keep the nominal profile/job height and integer layer in f64 until the
  // single printed-height f32 rounding; pre-rounding either changes the grid.
  const start = Math.fround(range.startMm);
  const end = Math.fround(range.endMm);
  const gridEnd = Math.fround(MAX_LAYER * layerHeightMm);
  // MAX_LAYER + 1 is an exact sentinel, never a physical layer. Each search
  // visits at most 32 cells, including f32 plateaus near the end of the grid.
  const bound = (endpoint: number, upper: boolean): number => {
    let low = 1;
    let high = MAX_LAYER + 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const printedHeight = Math.fround(middle * layerHeightMm);
      if (printedHeight < endpoint || (upper && printedHeight === endpoint)) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  // Preserve priority widths beyond the finite u32 grid using the same nominal
  // height. Derived f64 bounds may exceed u64; only sweep events are clipped.
  const startLayer = Number.isFinite(gridEnd) && start > gridEnd
    ? Math.max(MAX_LAYER + 1, Math.ceil(start / layerHeightMm))
    : bound(start, false);
  const endLayer = Number.isFinite(gridEnd) && end > gridEnd
    ? Math.floor(end / layerHeightMm)
    : bound(end, true) - 1;
  return startLayer <= endLayer ? { startLayer, endLayer } : null;
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
  layerHeightMm?: number,
): LayerSettingsSegment[] {
  const owned = parseLayerSettingsRanges(ranges);
  if (!Number.isInteger(totalLayers) || totalLayers < 0 || totalLayers > MAX_LAYER) {
    invalid('totalLayers must be an integer in 0..4294967295');
  }
  const bounds = owned.map((range) => resolveLayerSettingsRangeBounds(range, layerHeightMm));
  if (totalLayers === 0) return [];
  const spans = bounds.map((range) => range ? range.endLayer - range.startLayer + 1 : 0);
  const display = new RangeHeap(spans);
  const fields = LAYER_SETTING_FIELDS.map(() => new RangeHeap(spans));
  const active = owned.map(() => false);
  const events: { layer: number; index: number; starting: boolean }[] = [];
  bounds.forEach((range, index) => {
    if (!range || range.startLayer > totalLayers) return;
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
  return JSON.stringify(parseLayerSettingsRanges(ranges).map((range) => range.unit === 'mm' ? {
    unit: 'mm',
    startMm: range.startMm,
    endMm: range.endMm,
    settings: range.settings,
  } : {
    startLayer: range.startLayer,
    endLayer: range.endLayer,
    settings: range.settings,
  }));
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
