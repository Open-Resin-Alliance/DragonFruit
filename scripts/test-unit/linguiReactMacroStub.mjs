/**
 * Test-only stand-in for `@lingui/react/macro`, for the same reason as
 * `linguiCoreMacroStub.mjs`: the runtime package imports `babel-plugin-macros`.
 *
 * Without the macro, `<Trans>`'s children are the JSX the source wrote, so
 * rendering them as-is gives the English text. `<Plural>` picks its form the
 * way English does and puts the value in for `#`.
 */
export function Trans({ children }) {
  return children ?? null;
}

export function Plural({ value, one, other, ...exact }) {
  const form = exact[`_${value}`] ?? (value === 1 && one !== undefined ? one : other);
  return typeof form === 'string' ? form.replaceAll('#', String(value)) : form ?? null;
}
