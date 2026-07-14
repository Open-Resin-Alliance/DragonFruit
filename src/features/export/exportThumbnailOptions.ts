export type ExportThumbnailRenderOptions = {
  includeGradient: boolean;
  includeBuildPlate: boolean;
  includeGrid: boolean;
  centerOnModel: boolean;
};

export const EXPORT_THUMBNAIL_RENDER_OPTIONS_STORAGE_KEY = 'dragonfruit.slicing.thumbnailRenderOptions';
export const DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS: ExportThumbnailRenderOptions = {
  includeGradient: false,
  includeBuildPlate: false,
  includeGrid: false,
  centerOnModel: true,
};

export function resolveInitialExportThumbnailRenderOptions(): ExportThumbnailRenderOptions {
  if (typeof window === 'undefined') return DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS;

  try {
    const raw = window.localStorage.getItem(EXPORT_THUMBNAIL_RENDER_OPTIONS_STORAGE_KEY);
    if (!raw) return DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS;

    const parsed = JSON.parse(raw) as Partial<ExportThumbnailRenderOptions>;
    return {
      includeGradient: typeof parsed.includeGradient === 'boolean'
        ? parsed.includeGradient
        : DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS.includeGradient,
      includeBuildPlate: typeof parsed.includeBuildPlate === 'boolean'
        ? parsed.includeBuildPlate
        : DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS.includeBuildPlate,
      includeGrid: typeof parsed.includeGrid === 'boolean'
        ? parsed.includeGrid
        : DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS.includeGrid,
      centerOnModel: typeof parsed.centerOnModel === 'boolean'
        ? parsed.centerOnModel
        : DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS.centerOnModel,
    };
  } catch {
    return DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS;
  }
}
