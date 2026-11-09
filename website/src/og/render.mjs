/**
 * Social cards, rendered at build time.
 *
 * Every page gets one. The card is the site's own design language at 1200x630: the
 * ink background under the page wash from global.css, the brand ramp as the top
 * rule, Atkinson Hyperlegible Next for the prose and JetBrains Mono for the
 * micro-labels, the same split the stylesheet makes.
 *
 * The wash is not drawn by the renderer. It is the one thing on the card that is a
 * smooth ramp over a large area, which is exactly what 8-bit output cannot hold: the
 * dark theme's gradient spans about sixteen levels of red across the card, so every
 * level lasts thirty pixels and a rasteriser tells the truth about it, visibly. So
 * the gradient is computed here in floating point and quantised once, through Floyd
 * -Steinberg error diffusion, which trades a visible edge every thirty pixels for an
 * invisible error of less than one level per pixel. That is the difference between
 * dithering a gradient and adding noise to bands that a rasteriser already made.
 *
 * The rest of the card - the rule, the type, the emblem, the wordmark on the home card -
 * is rasterised by satori and resvg and composited over it. satori takes TTF and OTF but can read neither woff2
 * nor the `fvar` table of a variable font, so `src/og/fonts/` holds static instances
 * of the weights used, generated once from the same woff2 the site ships.
 */
import fs from 'node:fs';
import path from 'node:path';
import satori from 'satori';
import { html } from 'satori-html';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** The brand ramp, as the top rule: the stops and their positions, from the stylesheet. */
const BAR_HEIGHT = 8;
const BAR_MIDPOINT = 0.46;
const BAR_STOPS = [
  [0, [236, 42, 119]],
  [BAR_MIDPOINT, [252, 43, 113]],
  [1, [106, 184, 10]],
];

/**
 * The page wash, from `--wash-*` in global.css under the dark theme, over the dark
 * theme's `--bg`: 135 degrees, evenly spaced stops, 15% over the ink.
 */
const INK = [11, 15, 20];
const WASH_STOPS = [
  [236, 42, 119],
  [106, 184, 10],
  [236, 42, 119],
];
const WASH_ALPHA = 0.12;

/**
 * A title is two lines at this width and size, three at a push. A summary is allowed
 * three, which at 28px is about 210 characters - and the longest description on the site
 * is 206, so nothing is cut off in practice: these are a backstop against a fourth line,
 * which would reach the footer, not something the writing has to fit. Titles are cut at
 * 90. satori has no line clamping, so an overlong card would overlap rather than clip.
 */
/** The wordmark on the home card, at the width the site's own header gives it. */
const WORDMARK_WIDTH = 620;

const TITLE_CHARS = 90;
const SUMMARY_CHARS = 210;

const flat = (value) => (value ?? '').replace(/\s+/g, ' ').trim();

const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Cut on a word boundary, so the ellipsis never lands mid-word. */
function clamp(value, limit) {
  const text = flat(value);
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.]$/, '')}…`;
}

/** The card as markup, so the same strings can be laid out in a browser for checks. */
export function cardMarkup({ title, description, meta, mark, wordmark, centred = false }) {
  /* No background, no wash and no top rule: all three are painted from the computed
     base below, which is the only way they lose their 8-bit steps. */

  if (centred) {
    const { width, height } = wordmark;
    return `<div style="display:flex;flex-direction:column;width:${OG_WIDTH}px;height:${OG_HEIGHT}px;position:relative;overflow:hidden">
    <div style="display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;padding:64px 104px 0">
      <img src="${wordmark.src}" style="width:${WORDMARK_WIDTH}px;height:${Math.round(height * (WORDMARK_WIDTH / width))}px" />
      <div style="display:flex;font-family:Body;font-weight:400;font-size:34px;line-height:1.4;color:#cfcfd8;margin-top:38px;text-align:center;justify-content:center">${escapeHtml(description)}</div>
    </div>
    <div style="display:flex;align-items:center;justify-content:center;gap:18px;margin:0 76px;padding:22px 0 46px;border-top:1px solid rgba(255,255,255,0.14)">
      <img src="${mark}" style="width:36px;height:36px;border-radius:9999px" />
      <div style="display:flex;font-family:Mono;font-weight:500;font-size:19px;letter-spacing:1px;color:#8c8c98">dragonfruit-slicer.com</div>
    </div>
  </div>`;
  }

  return `<div style="display:flex;flex-direction:column;width:${OG_WIDTH}px;height:${OG_HEIGHT}px;position:relative;overflow:hidden">
    <div style="display:flex;flex-direction:column;padding:62px 76px 0">
      <div class="og-title" style="display:flex;font-family:Body;font-weight:700;font-size:68px;line-height:1.1;color:#fafafa">${escapeHtml(title)}</div>
      <div class="og-summary" style="display:flex;font-family:Body;font-weight:400;font-size:28px;line-height:1.42;color:#a6a6b0;margin-top:22px">${escapeHtml(description)}</div>
    </div>
    <div class="og-spacer" style="display:flex;flex:1"></div>
    <div class="og-footer" style="display:flex;align-items:center;gap:18px;margin:0 76px;padding:22px 0 46px;border-top:1px solid rgba(255,255,255,0.14)">
      <img src="${mark}" style="width:36px;height:36px;border-radius:9999px" />
      <div style="display:flex;font-family:Mono;font-weight:500;font-size:19px;letter-spacing:1px;color:#8c8c98">dragonfruit-slicer.com</div>
      <div style="display:flex;flex:1"></div>${meta ? `
      <div style="display:flex;font-family:Mono;font-weight:500;font-size:19px;letter-spacing:1px;color:#8c8c98">${escapeHtml(meta)}</div>` : ''}
    </div>
  </div>`;
}

let assets;

/** A PNG's pixel size, straight out of the IHDR chunk. Avoids a dependency for it. */
function pngSize(file) {
  const header = fs.readFileSync(file).subarray(0, 24);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/** Read once per build: the fonts, the emblem and the wordmark, reused by every card. */
function load() {
  if (assets) return assets;

  const here = import.meta.dirname;
  const read = (name) => fs.readFileSync(path.join(here, 'fonts', name));
  const inline = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

  assets = {
    fonts: [
      { name: 'Body', data: read('atkinson-hyperlegible-next-400.ttf'), weight: 400, style: 'normal' },
      { name: 'Body', data: read('atkinson-hyperlegible-next-600.ttf'), weight: 600, style: 'normal' },
      { name: 'Body', data: read('atkinson-hyperlegible-next-700.ttf'), weight: 700, style: 'normal' },
      { name: 'Mono', data: read('jetbrains-mono-500.ttf'), weight: 500, style: 'normal' },
      { name: 'Mono', data: read('jetbrains-mono-700.ttf'), weight: 700, style: 'normal' },
    ],
    mark: inline(path.join(here, 'brand', 'mark.png')),
    wordmark: (() => {
      const file = path.join(here, 'brand', 'wordmark.png');
      return { src: inline(file), ...pngSize(file) };
    })(),
  };

  return assets;
}

/**
 * One pixel of the background at full precision. Above the rule it is the brand ramp in
 * a straight horizontal line; below it, the page wash under CSS's 135 degrees, which
 * runs down and to the right, composited over the ink at the stops' alpha.
 */
function baseAt(x, y, width, height, into) {
  if (y < BAR_HEIGHT) {
    const t = (x + 0.5) / width;
    const index = t < BAR_MIDPOINT ? 0 : 1;
    const [at, from] = BAR_STOPS[index];
    const [next, to] = BAR_STOPS[index + 1];
    const edge = (t - at) / (next - at);
    for (let channel = 0; channel < 3; channel += 1) into[channel] = from[channel] + (to[channel] - from[channel]) * edge;
    return;
  }

  const washY = y - BAR_HEIGHT;
  const washHeight = height - BAR_HEIGHT;
  const dx = Math.SQRT1_2;
  const dy = Math.SQRT1_2;
  const length = Math.abs(width * dx) + Math.abs(washHeight * dy);
  const along = ((x + 0.5 - width / 2) * dx + (washY + 0.5 - washHeight / 2) * dy) / length + 0.5;
  const t = along < 0 ? 0 : along > 1 ? 1 : along;

  const [first, second, third] = WASH_STOPS;
  const from = t < 0.5 ? first : second;
  const to = t < 0.5 ? second : third;
  const edge = t < 0.5 ? t * 2 : (t - 0.5) * 2;

  for (let channel = 0; channel < 3; channel += 1) {
    const wash = from[channel] + (to[channel] - from[channel]) * edge;
    into[channel] = wash * WASH_ALPHA + INK[channel] * (1 - WASH_ALPHA);
  }
}

/**
 * The wash at 8 bits, by Floyd-Steinberg error diffusion, serpentine so the error
 * does not drift in one direction. Each pixel keeps its fraction of a level and
 * passes the rest to its neighbours: the ramp stays smooth to the eye, and no two
 * neighbouring pixels are further apart than one level, which is what stops an edge
 * forming every thirty pixels.
 */
function diffuseBase(width, height) {
  const out = Buffer.alloc(width * height * 3);
  const row = new Float32Array(width * 3);
  const next = new Float32Array(width * 3);
  const ideal = new Float32Array(3);

  for (let y = 0; y < height; y += 1) {
    const rightward = y % 2 === 0;
    for (let step = 0; step < width; step += 1) {
      const x = rightward ? step : width - 1 - step;
      const ahead = rightward ? 1 : -1;
      baseAt(x, y, width, height, ideal);

      const written = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const wanted = ideal[channel] + row[x * 3 + channel];
        const quantised = wanted < 0 ? 0 : wanted > 255 ? 255 : Math.round(wanted);
        out[written + channel] = quantised;
        const error = wanted - quantised;

        if (x + ahead >= 0 && x + ahead < width) row[(x + ahead) * 3 + channel] += (error * 7) / 16;
        next[x * 3 + channel] += (error * 5) / 16;
        if (x - ahead >= 0 && x - ahead < width) next[(x - ahead) * 3 + channel] += (error * 3) / 16;
        if (x + 2 * ahead >= 0 && x + 2 * ahead < width) next[(x + 2 * ahead) * 3 + channel] += error / 16;
      }
    }
    row.set(next);
    next.fill(0);
  }

  return out;
}

/** A card as a PNG buffer. `centred` is the home card: the wordmark and the line. */
export async function renderCard({ title, description, meta, centred = false }) {
  const { fonts, mark, wordmark } = load();
  const markup = cardMarkup({
    title: clamp(title, TITLE_CHARS),
    description: clamp(description, SUMMARY_CHARS),
    meta: flat(meta),
    mark,
    wordmark,
    centred,
  });

  const svg = await satori(html(markup), { width: OG_WIDTH, height: OG_HEIGHT, fonts });
  const drawn = new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } }).render().asPng();
  const { data, info } = await sharp(drawn).raw().toBuffer({ resolveWithObject: true });

  /* The rule and the wash are both in the base now; the rest is drawn over it. */
  const base = diffuseBase(info.width, info.height);
  const out = Buffer.alloc(info.width * info.height * 3);

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const from = (y * info.width + x) * info.channels;
      const to = (y * info.width + x) * 3;
      const alpha = data[from + 3] / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        out[to + channel] = base[to + channel] * (1 - alpha) + data[from + channel] * alpha;
      }
    }
  }

  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
