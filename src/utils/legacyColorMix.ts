/**
 * `color-mix()` for the macOS 12 webview (WebKit 15.6; the function arrived in
 * Safari 16.2).
 *
 * Stylesheets are covered at build time: Lightning CSS adds a fallback and
 * `globals.css` carries exact values for the theme variables. Inline styles
 * have no build step, and the app writes a thousand `color-mix()` calls in
 * `style={{…}}`. WebKit drops each such declaration whole, so a background
 * goes transparent and a border falls back to `currentColor`, which is the
 * white of the text.
 *
 * Where `CSS.supports` says the function is missing, this computes each mix
 * as it is written and stores a plain `rgb()`/`rgba()` instead:
 *
 * - through the `CSSStyleDeclaration` setters and `setProperty`, which is how
 *   React writes styles;
 * - through `setAttribute` for the SVG paint attributes (`fill`, `stroke`, …);
 * - over the prerendered HTML once, since the parser has already dropped those
 *   declarations but kept the attribute text.
 *
 * Variables resolve against the declaration itself, then the root element: the
 * mixes in the code use theme tokens. The computed colours are written again
 * when the theme changes. Delete this module when macOS 12 is dropped (see the
 * temporary rule in `docs/dev/backlog.md`).
 */

import { createPerfLogger } from '@/utils/debug/perfLog';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Reads a custom property's value, or `undefined` when it is not set. */
export type VarLookup = (name: string) => string | undefined;
/** Turns a CSS colour string into channels, or `null` when it cannot. */
export type ColorParser = (text: string) => Rgba | null;

const MAX_DEPTH = 8;
const FUNCTION_NAME = 'color-mix(';

/**
 * Replaces every `color-mix(in srgb, …)` in a declaration value with the colour
 * it computes to. Returns `null` when any of them cannot be computed (another
 * colour space, an unknown variable, a colour the parser does not know), so the
 * caller can leave the value as it was.
 */
export function rewriteColorMix(value: string, lookup: VarLookup, parse: ColorParser = parseColor, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  let out = '';
  let from = 0;
  for (;;) {
    const start = value.indexOf(FUNCTION_NAME, from);
    if (start < 0) return out + value.slice(from);
    const open = start + FUNCTION_NAME.length - 1;
    const close = matchingParen(value, open);
    if (close < 0) return null;
    const mixed = mixArguments(value.slice(open + 1, close), lookup, parse, depth);
    if (!mixed) return null;
    out += value.slice(from, start) + formatColor(mixed);
    from = close + 1;
  }
}

function mixArguments(args: string, lookup: VarLookup, parse: ColorParser, depth: number): Rgba | null {
  const parts = splitTopLevel(args, ',');
  if (parts.length !== 3) return null;
  if (parts[0].trim().toLowerCase().replace(/\s+/g, ' ') !== 'in srgb') return null;
  const first = parseComponent(parts[1]);
  const second = parseComponent(parts[2]);
  if (!first || !second) return null;
  const c1 = resolveColor(first.color, lookup, parse, depth);
  const c2 = resolveColor(second.color, lookup, parse, depth);
  if (!c1 || !c2) return null;
  return mixSrgb(c1, first.percent, c2, second.percent);
}

/** One `<color> <percentage>?` argument, the percentage on either side. */
function parseComponent(text: string): { color: string; percent: number | undefined } | null {
  const trimmed = text.trim();
  const trailing = /^(.*\S)\s+(-?\d*\.?\d+)%$/s.exec(trimmed);
  if (trailing) return { color: trailing[1], percent: Number(trailing[2]) / 100 };
  const leading = /^(-?\d*\.?\d+)%\s+(.+)$/s.exec(trimmed);
  if (leading) return { color: leading[2], percent: Number(leading[1]) / 100 };
  return trimmed ? { color: trimmed, percent: undefined } : null;
}

function resolveColor(text: string, lookup: VarLookup, parse: ColorParser, depth: number): Rgba | null {
  const substituted = substituteVars(text, lookup, depth + 1);
  if (substituted === null) return null;
  const flat = substituted.includes(FUNCTION_NAME) ? rewriteColorMix(substituted, lookup, parse, depth + 1) : substituted;
  return flat === null ? null : parse(flat.trim());
}

/** Replaces `var(--name, fallback)` with the variable's value, recursively. */
export function substituteVars(text: string, lookup: VarLookup, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  let out = '';
  let from = 0;
  for (;;) {
    const start = text.indexOf('var(', from);
    if (start < 0) return out + text.slice(from);
    const close = matchingParen(text, start + 3);
    if (close < 0) return null;
    const [name, ...rest] = splitTopLevel(text.slice(start + 4, close), ',');
    const fallback = rest.length > 0 ? rest.join(',') : undefined;
    const raw = lookup(name.trim()) ?? fallback;
    if (raw === undefined) return null;
    const value = substituteVars(raw.trim(), lookup, depth + 1);
    if (value === null) return null;
    out += text.slice(from, start) + value;
    from = close + 1;
  }
}

/**
 * The spec's mix in sRGB with premultiplied alpha: missing percentages take
 * the rest of 100%, a pair that adds up to anything else is scaled to 100%,
 * and a pair under 100% also scales the result's alpha down.
 */
export function mixSrgb(c1: Rgba, p1: number | undefined, c2: Rgba, p2: number | undefined): Rgba | null {
  let w1 = p1;
  let w2 = p2;
  if (w1 === undefined && w2 === undefined) {
    w1 = 0.5;
    w2 = 0.5;
  } else if (w1 === undefined) {
    w1 = 1 - (w2 as number);
  } else if (w2 === undefined) {
    w2 = 1 - w1;
  }
  const a1 = w1 as number;
  const a2 = w2 as number;
  if (a1 < 0 || a2 < 0 || a1 > 1 || a2 > 1) return null;
  const sum = a1 + a2;
  if (sum === 0) return null;
  const alphaScale = Math.min(1, sum);
  const n1 = a1 / sum;
  const n2 = a2 / sum;
  const alpha = c1.a * n1 + c2.a * n2;
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (x: number, y: number) => (x * c1.a * n1 + y * c2.a * n2) / alpha;
  return { r: channel(c1.r, c2.r), g: channel(c1.g, c2.g), b: channel(c1.b, c2.b), a: alpha * alphaScale };
}

export function formatColor({ r, g, b, a }: Rgba): string {
  const rgb = `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`;
  const alpha = Math.round(a * 1000) / 1000;
  return alpha >= 1 ? `rgb(${rgb})` : `rgba(${rgb}, ${alpha})`;
}

const NAMED: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
};

/**
 * Hex, `rgb()`/`rgba()` (comma or space syntax) and the three keywords the code
 * mixes with. Anything else goes to `fallback` (the browser's own parser).
 */
export function parseColor(text: string, fallback?: ColorParser): Rgba | null {
  const lower = text.trim().toLowerCase();
  const named = NAMED[lower];
  if (named) return { ...named };
  const hex = /^#([0-9a-f]{3,8})$/.exec(lower);
  if (hex) return parseHex(hex[1]);
  const fn = /^rgba?\((.*)\)$/s.exec(lower);
  if (fn) return parseRgbArgs(fn[1]);
  return fallback ? fallback(text) : null;
}

function parseHex(digits: string): Rgba | null {
  if (digits.length === 3 || digits.length === 4) {
    const [r, g, b, a = 'f'] = digits.split('');
    return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16), a: parseInt(a + a, 16) / 255 };
  }
  if (digits.length === 6 || digits.length === 8) {
    const pair = (i: number) => parseInt(digits.slice(i, i + 2), 16);
    return { r: pair(0), g: pair(2), b: pair(4), a: digits.length === 8 ? pair(6) / 255 : 1 };
  }
  return null;
}

function parseRgbArgs(args: string): Rgba | null {
  const [channels, slashAlpha] = args.split('/');
  const parts = channels.split(/[\s,]+/).filter(Boolean);
  if (slashAlpha !== undefined && parts.length !== 3) return null;
  if (parts.length !== 3 && parts.length !== 4) return null;
  const alphaText = slashAlpha?.trim() ?? parts[3];
  const channel = (p: string) => (p.endsWith('%') ? (Number(p.slice(0, -1)) * 255) / 100 : Number(p));
  const alpha = alphaText === undefined ? 1 : alphaText.endsWith('%') ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
  const values = [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha];
  if (values.some((v) => !Number.isFinite(v))) return null;
  return { r: values[0], g: values[1], b: values[2], a: Math.min(1, Math.max(0, values[3])) };
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

// ---------------------------------------------------------------------------
// Installation

/** The SVG presentation attributes that take a colour. */
const COLOR_ATTRIBUTES = new Set(['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color', 'color']);
const SET_PROPERTY_KEY = '\0';
const CACHE_LIMIT = 4000;

interface ShimStats {
  path: 'accessors' | 'proxy' | 'none';
  wrapped: number;
  rewritten: number;
  unresolved: number;
  swept: number;
  unresolvedSamples: string[];
}

export interface ColorMixShimOptions {
  /** Install even where `color-mix()` works, to compare against the native one. */
  force?: boolean;
}

/**
 * Installs the shim where `color-mix()` is missing (or when forced). Returns
 * whether it was installed.
 */
export function installColorMixShim(options: ColorMixShimOptions = {}): boolean {
  if (typeof document === 'undefined' || typeof CSSStyleDeclaration === 'undefined') return false;
  const supported = typeof CSS !== 'undefined' && CSS.supports?.('color', 'color-mix(in srgb, red 50%, blue)');
  if (supported && !options.force) return false;

  const stats: ShimStats = { path: 'none', wrapped: 0, rewritten: 0, unresolved: 0, swept: 0, unresolvedSamples: [] };
  const cache = new Map<string, string | null>();
  const browserParse = canvasColorParser();
  const parse: ColorParser = (text) => parseColor(text, browserParse);
  // Theme tokens, read once each: a computed-style read in the middle of a
  // React commit would make the browser recompute styles for every write. A
  // theme change clears it. Misses are not kept, in case the stylesheet had not
  // applied yet.
  const rootVars = new Map<string, string>();
  const rootLookup = (name: string): string | undefined => {
    const known = rootVars.get(name);
    if (known !== undefined) return known;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!value) return undefined;
    rootVars.set(name, value);
    return value;
  };

  /** The rewritten value, or the original when it cannot be computed. */
  const resolve = (value: string, local?: CSSStyleDeclaration): string => {
    const cached = local ? undefined : cache.get(value);
    let result = cached;
    if (cached === undefined) {
      const lookup: VarLookup = local
        ? (name) => local.getPropertyValue(name).trim() || rootLookup(name)
        : rootLookup;
      result = rewriteColorMix(value, lookup, parse);
      if (!local) {
        if (cache.size >= CACHE_LIMIT) cache.clear();
        cache.set(value, result);
      }
      if (result === null) {
        stats.unresolved++;
        if (stats.unresolvedSamples.length < 5) stats.unresolvedSamples.push(value.slice(0, 160));
      } else {
        stats.rewritten++;
      }
    }
    return result ?? value;
  };

  // What each tracked target was given, so a theme change can compute it again.
  const originals = new WeakMap<object, Map<string, string>>();
  const tracked = new Set<WeakRef<object>>();
  const track = (target: object, key: string, value: string | null) => {
    let entries = originals.get(target);
    if (value === null) {
      entries?.delete(key);
      return;
    }
    if (!entries) {
      entries = new Map();
      originals.set(target, entries);
      tracked.add(new WeakRef(target));
    }
    entries.set(key, value);
  };

  // How assignments like `style.background = …` are caught depends on the
  // engine. Where each property is an accessor on the prototype, the accessors
  // are wrapped. Where they are the declaration's own properties (Blink), the
  // `style` getter hands out a Proxy instead. Exactly one of the two runs, or
  // a value would be intercepted twice.
  const setters = new Map<string, (this: CSSStyleDeclaration, value: unknown) => void>();
  const styleProtos = [
    CSSStyleDeclaration.prototype,
    (globalThis as { CSSStyleProperties?: typeof CSSStyleDeclaration }).CSSStyleProperties?.prototype,
    (globalThis as { CSS2Properties?: typeof CSSStyleDeclaration }).CSS2Properties?.prototype,
  ].filter((proto): proto is CSSStyleDeclaration => proto !== undefined);
  const hasAccessors = styleProtos.some((proto) => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'backgroundColor');
    return Boolean(descriptor?.set && descriptor.configurable);
  });
  if (hasAccessors) {
    stats.path = 'accessors';
    for (const proto of styleProtos) wrapStyleAccessors(proto, setters, intercept);
    stats.wrapped = setters.size;
  } else {
    stats.path = 'proxy';
    stats.wrapped = proxyStyleGetters(intercept);
  }

  function intercept(declaration: CSSStyleDeclaration, key: string, value: unknown): unknown {
    if (typeof value === 'string' && value.includes(FUNCTION_NAME)) {
      track(declaration, key, value);
      return resolve(value, declaration);
    }
    if (originals.has(declaration)) track(declaration, key, null);
    return value;
  }

  const nativeSetProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function setProperty(name: string, value: string | null, priority?: string) {
    return nativeSetProperty.call(this, name, intercept(this, SET_PROPERTY_KEY + name, value) as string | null, priority);
  };

  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function setAttribute(name: string, value: string) {
    if (COLOR_ATTRIBUTES.has(name) && typeof value === 'string') {
      if (value.includes(FUNCTION_NAME)) {
        track(this, name, value);
        return nativeSetAttribute.call(this, name, resolve(value));
      }
      if (originals.has(this)) track(this, name, null);
    }
    return nativeSetAttribute.call(this, name, value);
  };

  const reapply = () => {
    cache.clear();
    rootVars.clear();
    for (const ref of tracked) {
      const target = ref.deref();
      const entries = target && originals.get(target);
      if (!target || !entries || entries.size === 0) {
        tracked.delete(ref);
        continue;
      }
      for (const [key, value] of entries) {
        if (target instanceof Element) {
          nativeSetAttribute.call(target, key, resolve(value));
          continue;
        }
        // Written past the interception, which would otherwise see a plain
        // colour and forget the original.
        const declaration = target as CSSStyleDeclaration;
        const computed = resolve(value, declaration);
        const setter = setters.get(key);
        if (key.startsWith(SET_PROPERTY_KEY)) nativeSetProperty.call(declaration, key.slice(1), computed);
        else if (setter) setter.call(declaration, computed);
        else Reflect.set(declaration, key, computed);
      }
    }
  };

  // A theme change rewrites the root's variables (an attribute, a class, its
  // inline custom properties, or the system appearance). Only a change to a
  // variable the mixes read is worth computing everything again for.
  const themeChanged = () => {
    if (rootVars.size === 0) return false;
    const computed = getComputedStyle(document.documentElement);
    for (const [name, value] of rootVars) {
      if (computed.getPropertyValue(name).trim() !== value) return true;
    }
    return false;
  };
  const onThemeSignal = () => {
    if (!themeChanged()) return;
    reapply();
    // A tracked value on the root element is written back by `reapply`; that
    // write is not a theme change.
    themeObserver.takeRecords();
  };
  const themeObserver = new MutationObserver(onThemeSignal);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class', 'style'],
  });
  matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', onThemeSignal);

  // The prerendered HTML: the parser dropped these declarations, but the
  // attribute still holds them as written.
  const sweep = () => {
    for (const element of document.querySelectorAll<HTMLElement | SVGElement>('[style*="color-mix"]')) {
      const text = element.getAttribute('style') ?? '';
      for (const declaration of splitTopLevel(text, ';')) {
        const colon = declaration.indexOf(':');
        if (colon < 0) continue;
        const value = declaration.slice(colon + 1).trim();
        if (!value.includes(FUNCTION_NAME)) continue;
        element.style.setProperty(declaration.slice(0, colon).trim(), value);
        stats.swept++;
      }
    }
    for (const name of COLOR_ATTRIBUTES) {
      for (const element of document.querySelectorAll(`[${name}*="color-mix"]`)) {
        element.setAttribute(name, element.getAttribute(name) ?? '');
        stats.swept++;
      }
    }
  };
  if (document.readyState !== 'loading') sweep();
  document.addEventListener('DOMContentLoaded', sweep, { once: true });

  // The native log is only there once its plugin has loaded, so report later.
  const log = createPerfLogger();
  setTimeout(() => {
    const samples = stats.unresolvedSamples.length > 0 ? ` — unresolved: ${stats.unresolvedSamples.join(' | ')}` : '';
    log.info(
      `[compat] color-mix shim${supported ? ' (forced)' : ''}: style writes caught by ${stats.path} (${stats.wrapped}), ` +
        `${stats.swept} prerendered values, ${stats.rewritten} computed, ${stats.unresolved} left as written${samples}`,
    );
  }, 15_000);

  if (options.force) {
    (globalThis as { __dfColorMixShim?: unknown }).__dfColorMixShim = { stats, resolve, rewriteColorMix, parse, rootLookup };
  }
  return true;
}

type Intercept = (declaration: CSSStyleDeclaration, key: string, value: unknown) => unknown;

function wrapStyleAccessors(proto: CSSStyleDeclaration, setters: Map<string, (this: CSSStyleDeclaration, value: unknown) => void>, intercept: Intercept): void {
  for (const name of Object.getOwnPropertyNames(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    const set = descriptor?.set;
    if (!descriptor || !set || !descriptor.configurable) continue;
    setters.set(name, set);
    Object.defineProperty(proto, name, {
      ...descriptor,
      set(this: CSSStyleDeclaration, value: unknown) {
        set.call(this, intercept(this, name, value));
      },
    });
  }
}

/**
 * Makes `element.style` return a Proxy over the real declaration, one per
 * declaration so `el.style === el.style` still holds. Methods are bound to the
 * real declaration, which native code requires. Returns how many `style`
 * getters were wrapped.
 */
function proxyStyleGetters(intercept: Intercept): number {
  const proxies = new WeakMap<CSSStyleDeclaration, CSSStyleDeclaration>();
  const bound = new WeakMap<CSSStyleDeclaration, Map<PropertyKey, unknown>>();
  const handler: ProxyHandler<CSSStyleDeclaration> = {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      let methods = bound.get(target);
      if (!methods) {
        methods = new Map();
        bound.set(target, methods);
      }
      let method = methods.get(key);
      if (!method) {
        method = (value as (...args: unknown[]) => unknown).bind(target);
        methods.set(key, method);
      }
      return method;
    },
    set(target, key, value: unknown) {
      return Reflect.set(target, key, typeof key === 'string' ? intercept(target, key, value) : value, target);
    },
  };
  const owners = [
    globalThis.HTMLElement?.prototype,
    globalThis.SVGElement?.prototype,
    (globalThis as { MathMLElement?: { prototype: Element } }).MathMLElement?.prototype,
    globalThis.Element?.prototype,
  ];
  let wrapped = 0;
  for (const owner of owners) {
    if (!owner) continue;
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'style');
    const get = descriptor?.get;
    if (!descriptor || !get || !descriptor.configurable) continue;
    Object.defineProperty(owner, 'style', {
      ...descriptor,
      get(this: Element) {
        const declaration = get.call(this) as CSSStyleDeclaration;
        let proxy = proxies.get(declaration);
        if (!proxy) {
          proxy = new Proxy(declaration, handler);
          proxies.set(declaration, proxy);
        }
        return proxy;
      },
    });
    wrapped++;
  }
  return wrapped;
}

/** The browser's colour parser, through a 2D canvas's `fillStyle`. */
function canvasColorParser(): ColorParser | undefined {
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = document.createElement('canvas').getContext('2d');
  } catch {
    return undefined;
  }
  if (!context) return undefined;
  const ctx = context;
  return (text) => {
    // An invalid colour leaves fillStyle alone, so two different sentinels tell
    // a real black or white from a rejected string.
    ctx.fillStyle = '#000000';
    ctx.fillStyle = text;
    const first = String(ctx.fillStyle);
    ctx.fillStyle = '#ffffff';
    ctx.fillStyle = text;
    if (String(ctx.fillStyle) !== first) return null;
    return parseColor(first);
  };
}
