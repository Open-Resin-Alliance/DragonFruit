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

export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { locale, setLocale } = useLocale();

  return (
    <SelectDropdown<Locale>
      value={locale}
      options={OPTIONS}
      onChange={setLocale}
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
