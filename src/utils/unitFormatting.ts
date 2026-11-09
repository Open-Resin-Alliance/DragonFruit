/**
 * Numbers with units for user-visible text, translated through the catalog.
 *
 * Unit symbols are not universal: Cyrillic, Hebrew and Arabic locales write
 * "мм", "מ״מ", "مم", and locales differ on spacing ("28 %" vs "28%"). Each unit
 * is one message with a `{value}` placeholder so translators control both the
 * symbol and where the number goes. The number itself comes formatted for
 * the locale (localeNumber.ts) before it is placed.
 *
 * The descriptors live at module scope with an explicit `{value}` placeholder,
 * so React Compiler has no interpolated local to rename (see AGENTS.md).
 * Components get these through `useLocaleFormat()`: `fmt.quantity(x, 2, 'mm')`.
 * The object is cached per `_`, which changes identity on a locale switch, so
 * React Compiler recomputes memoized output.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { localeFormat, type LocaleFormat } from './localeNumber';

export type Translate = (descriptor: MessageDescriptor) => string;

const UNIT_MESSAGES = {
  mm: msg({ message: '{value} mm', comment: 'Length in millimetres. {value} is an already formatted number.' }),
  mm2: msg({ message: '{value} mm²', comment: 'Area in square millimetres. {value} is an already formatted number.' }),
  mm3: msg({ message: '{value} mm³', comment: 'Volume in cubic millimetres. {value} is an already formatted number.' }),
  cm3: msg({ message: '{value} cm³', comment: 'Volume in cubic centimetres. {value} is an already formatted number.' }),
  um: msg({ message: '{value} μm', comment: 'Length in micrometres (layer height). {value} is an already formatted number.' }),
  ml: msg({ message: '{value} ml', comment: 'Resin volume in millilitres. {value} is an already formatted number.' }),
  mmPerPx: msg({ message: '{value} mm/px', comment: 'Millimetres per screen/layer pixel. {value} is an already formatted number.' }),
  g: msg({ message: '{value} g', comment: 'Weight in grams. {value} is an already formatted number.' }),
  B: msg({ message: '{value} B', comment: 'File or memory size in bytes. {value} is an already formatted number.' }),
  KB: msg({ message: '{value} KB', comment: 'File or memory size in kilobytes (1024 bytes). {value} is an already formatted number.' }),
  MB: msg({ message: '{value} MB', comment: 'File or memory size in megabytes. {value} is an already formatted number.' }),
  GB: msg({ message: '{value} GB', comment: 'File or memory size in gigabytes. {value} is an already formatted number.' }),
  TB: msg({ message: '{value} TB', comment: 'File size in terabytes. {value} is an already formatted number.' }),
  s: msg({ message: '{value} s', comment: 'Duration in seconds (exposure, run time). {value} is an already formatted number.' }),
  ms: msg({ message: '{value} ms', comment: 'Duration in milliseconds. {value} is an already formatted number.' }),
  fps: msg({ message: '{value} fps', comment: 'Frame rate, frames per second. {value} is an already formatted number.' }),
  perSecond: msg({ message: '{value} /s', comment: 'A rate: how many times per second. {value} is an already formatted number.' }),
  percent: msg({ message: '{value}%', comment: 'Percentage. {value} is an already formatted number.' }),
  degree: msg({ message: '{value}°', comment: 'Angle in degrees. {value} is an already formatted, possibly signed number.' }),
  times: msg({ message: '{value}x', comment: 'A multiplier, as in "1.50x" faster. {value} is an already formatted number.' }),
  thousands: msg({ message: '{value}K', comment: 'Compact count in thousands, as in "50K polygons". {value} is an already formatted number.' }),
  millions: msg({ message: '{value}M', comment: 'Compact count in millions, as in "1.38M polygons". {value} is an already formatted number.' }),
} satisfies Record<string, MessageDescriptor>;

export type Unit = keyof typeof UNIT_MESSAGES;

/** Places an already formatted number in its unit's message. */
/** `LocaleFormat` plus the unit messages, bound to one locale and catalog. */
export interface UnitFormat extends LocaleFormat {
  /** `fixed(value, fractionDigits)` placed in the unit's message. */
  quantity(value: number, fractionDigits: number, unit: Unit): string;
  /** An already formatted number placed in the unit's message. */
  unit(unit: Unit, value: string): string;
}

const unitFormats = new WeakMap<Translate, Map<string, UnitFormat>>();

/** The formatters for `locale` and `translate`, cached so identity only changes with them. */
export function unitFormat(locale: string, translate: Translate): UnitFormat {
  let byLocale = unitFormats.get(translate);
  if (!byLocale) {
    byLocale = new Map();
    unitFormats.set(translate, byLocale);
  }
  let format = byLocale.get(locale);
  if (!format) {
    const numbers = localeFormat(locale);
    const unit = (unitKey: Unit, value: string) => translate({ ...UNIT_MESSAGES[unitKey], values: { value } });
    format = {
      ...numbers,
      unit,
      quantity: (value, fractionDigits, unitKey) => unit(unitKey, numbers.fixed(value, fractionDigits)),
    };
    byLocale.set(locale, format);
  }
  return format;
}
