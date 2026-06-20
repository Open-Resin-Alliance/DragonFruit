"use client";

import React from "react";
import { Languages } from "lucide-react";
import { SelectDropdown } from "@/components/ui/SelectDropdown";
import { useLocale } from "@/components/I18nClientProvider";
import { SUPPORTED_LOCALES, LOCALE_LABELS, type Locale } from "@/i18n";

const OPTIONS = SUPPORTED_LOCALES.map((locale) => ({
  value: locale,
  label: LOCALE_LABELS[locale],
}));

export function LanguageSwitcher({
  className = "",
  value,
  onChange,
}: {
  className?: string;
  // Controlled mode (e.g. the Settings modal's draft state): when provided, the
  // switcher reports changes via onChange instead of switching the locale live.
  // Falls back to the active locale / live switch when omitted.
  value?: Locale;
  onChange?: (locale: Locale) => void;
}) {
  const { locale, setLocale } = useLocale();
  const currentValue = value ?? locale;
  const handleChange = onChange ?? setLocale;

  return (
    <SelectDropdown<Locale>
      value={currentValue}
      options={OPTIONS}
      onChange={handleChange}
      ariaLabel="Language"
      title="Language"
      // Fixed width so the trigger and the (width-matched) menu are the same
      // compact size; menuAlign right then drops the menu cleanly below it.
      className={`w-36 ${className}`}
      menuAlign="right"
      leadingDisplay={<Languages className="w-4 h-4" />}
      // .ui-input (unlayered CSS) overrides the trigger's Tailwind text-sm/pr-10,
      // making the font too large and the chevron overlap the text. The !
      // important utilities beat the unlayered rule.
      selectClassName="!text-[13px] !pr-9"
    />
  );
}
