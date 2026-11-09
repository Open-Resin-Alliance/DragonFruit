import { useLingui } from '@lingui/react';
import { unitFormat, type UnitFormat } from '@/utils/unitFormatting';

/** Number and unit formatters for the active Lingui locale; a new object after a locale switch. */
export function useLocaleFormat(): UnitFormat {
  const { _, i18n } = useLingui();
  return unitFormat(i18n.locale, _);
}
