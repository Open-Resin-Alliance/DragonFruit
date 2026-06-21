import { defineConfig } from "@lingui/conf";

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "es", "de", "fr"],
  catalogs: [
    {
      path: "src/locales/{locale}",
      include: ["src/**"],
      exclude: ["src/**/__tests__/**"],
    },
  ],
  // format defaults to PO in v6; import from @lingui/format-po to customise
});
