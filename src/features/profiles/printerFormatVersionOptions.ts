import { normalizeFormatVersion } from './outputFormatUtils';

export type PrinterFormatVersionOption = {
  value: string;
  label: string;
  isDefault?: boolean;
};

export function sanitizePrinterFormatVersionOptions(value: unknown): PrinterFormatVersionOption[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const seen = new Set<string>();
  const options = value.slice(0, 16).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];

    const option = entry as Record<string, unknown>;
    const normalizedValue = normalizeFormatVersion(option.value);
    const label = typeof option.label === 'string' ? option.label.trim().slice(0, 120) : '';
    if (!normalizedValue || !label) return [];

    const key = normalizedValue.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);

    return [{
      value: normalizedValue,
      label,
      ...(option.isDefault === true ? { isDefault: true } : {}),
    }];
  });

  return options.length > 0 ? options : undefined;
}

export function resolvePrinterFormatVersionOptions(
  availableOptions: PrinterFormatVersionOption[],
  curatedOptions: PrinterFormatVersionOption[] | undefined,
): PrinterFormatVersionOption[] {
  if (!curatedOptions?.length) return availableOptions;

  const availableByValue = new Map(
    availableOptions.map((option) => [option.value.toLowerCase(), option] as const),
  );
  const resolved = curatedOptions.flatMap((option) => {
    const available = availableByValue.get(option.value.toLowerCase());
    if (!available) return [];
    return [{
      value: available.value,
      label: option.label,
      ...(option.isDefault === true ? { isDefault: true } : {}),
    }];
  });

  return resolved.length > 0 ? resolved : availableOptions;
}

export function resolveFormatVersionFromOptions(
  requestedVersion: unknown,
  fallbackVersion: unknown,
  options: PrinterFormatVersionOption[] | undefined,
): string | undefined {
  const normalizedRequested = normalizeFormatVersion(requestedVersion);
  const normalizedFallback = normalizeFormatVersion(fallbackVersion);
  if (!options?.length) return normalizedRequested ?? normalizedFallback;

  const match = (value: string | undefined) => (
    value ? options.find((option) => option.value.toLowerCase() === value.toLowerCase()) : undefined
  );

  return (
    match(normalizedRequested)
    ?? match(normalizedFallback)
    ?? options.find((option) => option.isDefault)
    ?? options[0]
  )?.value;
}
