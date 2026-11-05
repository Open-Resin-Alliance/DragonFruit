/**
 * The machines the app ships profiles for, read from the printer packs that
 * plugins carry (`plugins/<id>/printers/*.json`) plus the core Generic Machine.
 *
 * The machines page renders this, and the landing page's hero quotes its count,
 * so the number a visitor reads is the number the app actually offers. A pack
 * that gains a machine changes both on the next build.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Preset {
  presetId?: string;
  name?: string;
  manufacturer?: string;
  family?: string;
  imageAssetPath?: string;
  pixelSize?: { x?: number; y?: number };
  buildVolumeMm?: { width?: number | null; depth?: number | null; height?: number | null };
  display?: { resolutionX?: number; resolutionY?: number; outputFormat?: string };
}

export interface Machine {
  slug: string;
  name: string;
  family: string;
  manufacturer: string;
  volume: string;
  resolution: string;
  format: string;
  /** Whether the pack ships a render, which `printer-images.mjs` turns into a thumbnail. */
  image: boolean;
}

export interface Family {
  name: string;
  machines: Machine[];
}

export interface Group {
  manufacturer: string;
  /** The manufacturer as an anchor target, so the rail works without a script. */
  slug: string;
  machines: Machine[];
  families: Family[];
}

export interface MachineLibrary {
  machines: Machine[];
  groups: Group[];
  formats: string[];
}

/** The build runs from `website/`, and the packs live beside it. */
function repoRoot(): URL {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(dir, 'plugins')) && existsSync(join(dir, 'website'))) {
      return new URL(`file://${dir.replace(/\\/g, '/')}/`);
    }
    dir = dirname(dir);
  }
  throw new Error(`machines: could not find the repository root from ${process.cwd()}`);
}

function number(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Rounded to a tenth of a millimetre, which is all a build volume needs. */
function millimetres(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function toMachine(preset: Preset, printersDir: string): Machine {
  const resolutionX = number(preset.display?.resolutionX);
  const resolutionY = number(preset.display?.resolutionY);
  const pitchX = number(preset.pixelSize?.x);
  const pitchY = number(preset.pixelSize?.y);

  /* The app derives a missing build area from the panel: pixels times pixel pitch,
     in micrometres. Athena's 16K profile ships that way. */
  const width = number(preset.buildVolumeMm?.width) ?? (resolutionX && pitchX ? (resolutionX * pitchX) / 1000 : null);
  const depth = number(preset.buildVolumeMm?.depth) ?? (resolutionY && pitchY ? (resolutionY * pitchY) / 1000 : null);
  const height = number(preset.buildVolumeMm?.height);

  const render = preset.imageAssetPath ? join(printersDir, preset.imageAssetPath) : null;

  return {
    slug: preset.presetId ?? 'machine',
    name: preset.name?.trim() || 'Unnamed machine',
    family: preset.family?.trim() || 'Other',
    manufacturer: preset.manufacturer?.trim() || 'Other',
    volume:
      width !== null && depth !== null && height !== null
        ? `${millimetres(width)} × ${millimetres(depth)} × ${millimetres(height)} mm`
        : 'Not declared',
    resolution: resolutionX !== null && resolutionY !== null ? `${resolutionX} × ${resolutionY}` : 'Not declared',
    format: preset.display?.outputFormat?.trim() || 'Not declared',
    image: render !== null && existsSync(render),
  };
}

let cached: MachineLibrary | null = null;

export function loadMachines(): MachineLibrary {
  if (cached) return cached;

  const root = repoRoot();
  const machines: Machine[] = [];

  const pluginsDir = fileURLToPath(new URL('plugins', root));
  for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;

    const printersDir = join(pluginsDir, plugin.name, 'printers');
    let files: string[];
    try {
      files = readdirSync(printersDir).filter((file) => file.endsWith('.json'));
    } catch {
      /* A plugin that ships a format or a protocol instead of a printer pack. */
      continue;
    }

    for (const file of files) {
      const presets = JSON.parse(readFileSync(fileURLToPath(new URL(`plugins/${plugin.name}/printers/${file}`, root)), 'utf8')) as Preset[];
      for (const preset of presets) {
        machines.push(toMachine(preset, printersDir));
      }
    }
  }

  const generic = JSON.parse(
    readFileSync(fileURLToPath(new URL('profiles/printers/generic/printers.json', root)), 'utf8'),
  ) as Preset[];
  for (const preset of generic) {
    machines.push(toMachine(preset, fileURLToPath(new URL('profiles/printers/generic', root))));
  }

  const byManufacturer = new Map<string, Map<string, Machine[]>>();
  for (const machine of machines) {
    const families = byManufacturer.get(machine.manufacturer) ?? new Map<string, Machine[]>();
    const family = families.get(machine.family) ?? [];
    family.push(machine);
    families.set(machine.family, family);
    byManufacturer.set(machine.manufacturer, families);
  }

  const groups: Group[] = [...byManufacturer.entries()]
    .map(([manufacturer, families]) => {
      const list: Family[] = [...families.entries()]
        .map(([name, entries]) => ({ name, machines: entries.sort((a, b) => a.name.localeCompare(b.name)) }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return {
        manufacturer,
        slug: manufacturer.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        machines: list.flatMap((family) => family.machines),
        families: list,
      };
    })
    .sort((a, b) => b.machines.length - a.machines.length || a.manufacturer.localeCompare(b.manufacturer));

  cached = {
    machines,
    groups,
    formats: [...new Set(machines.map((machine) => machine.format))].sort(),
  };

  return cached;
}
