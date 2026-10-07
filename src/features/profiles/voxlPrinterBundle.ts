import type { PrinterProfile, ProfileStoreState } from './profileStore';
import type { VoxlPrinterBundle, VoxlPrinterProfile } from '@/features/scene/voxl/types';

/**
 * Profile fields a scene does not carry: the network and connection state is
 * about the session you are in, not about the printer, and it holds a LAN
 * address and device ids.
 */
const PRINTER_BUNDLE_OMIT = [
  'network',
  'networkFleet',
  'networkConnection',
  'activeNetworkDeviceId',
];

/**
 * The bundle a scene embeds, from the live profile and the materials that belong
 * to it.
 *
 * The whole definition travels, so a custom printer is recreated on a machine
 * that has never seen it, and the network/session fields are left behind. An
 * uploaded photo is a data URL and would be duplicated into every save, so only
 * a factory printer's bundled asset path is kept.
 */
export function toVoxlPrinterBundle(
  profile: PrinterProfile,
  materials: unknown[],
): VoxlPrinterBundle {
  const definition: VoxlPrinterProfile = { ...profile };
  for (const key of PRINTER_BUNDLE_OMIT) delete definition[key];
  delete definition.imageDataUrl;

  if (typeof profile.imageDataUrl === 'string' && !profile.imageDataUrl.startsWith('data:')) {
    definition.imageDataUrl = profile.imageDataUrl;
  }

  return { version: 1, printer: definition, materials };
}

/**
 * Whether the selected profile is smaller than the printer a scene carries, on
 * any axis. A scene built for a bigger machine is the case worth interrupting an
 * import for: the plate it was packed for will not fit.
 */
export function buildVolumeIsSmaller(profile: PrinterProfile, bundle: VoxlPrinterBundle): boolean {
  const recorded = bundle.printer.buildVolumeMm;
  if (!recorded) return false;

  const volume = profile.buildVolumeMm;
  return (
    volume.width < recorded.width
    || volume.depth < recorded.depth
    || volume.height < recorded.height
  );
}

/**
 * The installed profile a bundle describes: the official preset it came from
 * first, then the local id it was written with, then its name. Null when this
 * machine has none of the three, and the caller adds the bundle instead.
 */
export function findPrinterProfileForBundle(
  bundle: VoxlPrinterBundle,
  state: ProfileStoreState,
): PrinterProfile | null {
  const printer = bundle.printer;

  const presetId = printer.officialPresetId;
  if (typeof presetId === 'string' && presetId.length > 0) {
    const byPreset = state.printerProfiles.find(
      (profile) => profile.officialPresetId === presetId,
    );
    if (byPreset) return byPreset;
  }

  const localId = printer.id;
  if (typeof localId === 'string' && localId.length > 0) {
    const byId = state.printerProfiles.find((profile) => profile.id === localId);
    if (byId) return byId;
  }

  const name = printer.name;
  if (typeof name === 'string' && name.trim().length > 0) {
    const wanted = name.trim().toLowerCase();
    return state.printerProfiles.find(
      (profile) => profile.name.trim().toLowerCase() === wanted,
    ) ?? null;
  }

  return null;
}
