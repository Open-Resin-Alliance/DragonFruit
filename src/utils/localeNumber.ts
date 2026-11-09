/**
 * Locale-aware number formatting for user-visible text.
 *
 * `toFixed` always writes "." as the decimal separator, so a Spanish UI shows
 * "28.03 MB" next to a Lingui plural that prints "560.464 polígonos". These
 * helpers go through Intl.NumberFormat with the active Lingui locale instead.
 *
 * Components use `useLocaleFormat()` and call `fmt.fixed(x, 2)`. The locale is
 * carried by the `fmt` object rather than read from `i18n.locale` in here:
 * React Compiler memoizes a call on the values it can see, so a hidden locale
 * read would leave the old language cached after a switch. `fmt` changes
 * identity with the locale, so the compiler recomputes. Helpers outside
 * components take `fmt` as an argument.
 *
 * Serialization, file names and logs keep `toFixed`/`String`, which stay
 * parseable. A field that shows the user a locale number reads it back with
 * `parseDecimal`.
 */

const formatters = new Map<string, Intl.NumberFormat>();

/** Formats `value` for `locale` with any Intl.NumberFormat options. */
export function formatNumber(value: number, locale: string, options?: Intl.NumberFormatOptions): string {
  const key = `${locale}|${options ? JSON.stringify(options) : ''}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    formatters.set(key, formatter);
  }
  return formatter.format(value);
}

/** The locale-aware counterpart of `value.toFixed(fractionDigits)`. */
export function formatFixed(value: number, fractionDigits: number, locale: string): string {
  return formatNumber(value, locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/**
 * A value as an editable field shows it, for `parseDecimal` to read back: no
 * thousands grouping, no trailing zeros, and never "-0".
 */
export function formatFieldNumber(value: number, maxFractionDigits: number, locale: string): string {
  const rounded = Number(value.toFixed(maxFractionDigits)) || 0;
  return formatNumber(rounded, locale, { maximumFractionDigits: maxFractionDigits, useGrouping: false });
}

/** The character `locale` writes between a number's whole and its fraction. */
export function decimalSeparator(locale: string): string {
  return formatNumber(1.5, locale).charAt(1);
}

/**
 * Reads a number typed into a field: the locale's decimal separator, or a ".",
 * which is what a number pad or a habit often types. NaN when the text, all of
 * it, isn't one.
 */
export function parseDecimal(text: string, locale: string): number {
  const separator = decimalSeparator(locale);
  const normalized = separator === '.' ? text.trim() : text.trim().replaceAll(separator, '.');
  return normalized === '' ? Number.NaN : Number(normalized);
}

/** Number formatting bound to one locale; see `localeFormat`. */
export interface LocaleFormat {
  readonly locale: string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  fixed(value: number, fractionDigits: number): string;
  /** `formatFieldNumber` for this locale. */
  field(value: number, maxFractionDigits: number): string;
  /** `parseDecimal` for this locale. */
  parse(text: string): number;
  /** `decimalSeparator` for this locale. */
  readonly decimalSeparator: string;
}

const localeFormats = new Map<string, LocaleFormat>();

/**
 * The formatters for `locale`, cached so the object keeps its identity until
 * the locale changes. Components get it from `useLocaleFormat()`.
 */
export function localeFormat(locale: string): LocaleFormat {
  let format = localeFormats.get(locale);
  if (!format) {
    format = {
      locale,
      number: (value, options) => formatNumber(value, locale, options),
      fixed: (value, fractionDigits) => formatFixed(value, fractionDigits, locale),
      field: (value, maxFractionDigits) => formatFieldNumber(value, maxFractionDigits, locale),
      parse: (text) => parseDecimal(text, locale),
      decimalSeparator: decimalSeparator(locale),
    };
    localeFormats.set(locale, format);
  }
  return format;
}
