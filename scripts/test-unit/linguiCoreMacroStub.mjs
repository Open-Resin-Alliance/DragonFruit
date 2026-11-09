/**
 * Test-only stand-in for `@lingui/core/macro`.
 *
 * The `msg` macro is compile-time: `@lingui/swc-plugin` rewrites it during the
 * Next build, and the runtime package it comes from (`@lingui/core/macro`)
 * imports `babel-plugin-macros`, which is deliberately not installed. So a Node
 * test that imports any module calling `msg` would fail to even load it.
 *
 * `register.mjs`, preloaded by `npm test`, resolves `@lingui/core/macro` here.
 * The descriptor this returns is the shape the macro produces for a static
 * message — `{ id, message }` — and the real `i18n._` falls back to `message`
 * when the id is not in the catalog, so the rendered English text is the
 * message the source wrote.
 */
export function msg(descriptor, ...values) {
  if (typeof descriptor === 'object' && !Array.isArray(descriptor)) return descriptor;
  const message = String.raw({ raw: descriptor }, ...values);
  return { id: message, message };
}

export const t = msg;
export const defineMessage = msg;
// English forms only: enough for a test to assert the rendered source text.
export const plural = (value, forms = {}) => {
  const form = forms[`=${value}`] ?? (value === 1 ? forms.one : undefined) ?? forms.other;
  return form === undefined ? String(value) : String(form).replaceAll('#', String(value));
};
export const select = (value, forms = {}) => String(forms[value] ?? forms.other ?? value);
export const selectOrdinal = (value) => String(value);
export const ph = (value) => String(value);
