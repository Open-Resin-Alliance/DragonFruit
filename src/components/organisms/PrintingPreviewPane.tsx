import React from 'react';
import * as THREE from 'three';
import { LayerSlider } from '@/components/controls/LayerSlider';
import { PrintingLayerGpuPreview } from '@/components/controls/PrintingLayerGpuPreview';
import type { PrinterProfile } from '@/features/profiles/profileStore';

type PreviewTargetResolution = {
  widthPx: number;
  heightPx: number;
  viewportWidth: number;
  viewportHeight: number;
} | null;

export type PrintingPreviewPaneProps = {
  printingPreviewTotalLayers: number;
  printingSelectedLayer: number;
  handlePrintingLayerChange: (layer: number) => void;
  handlePrintingLayerScrubStart: () => void;
  handlePrintingLayerScrubEnd: () => void;
  printingCurrentHeightMm: number | null;
  slicingHeightMm: number;
  crossSectionMode: 'smooth' | 'rasterized';

  printingPreviewViewportRef: React.RefObject<HTMLDivElement | null>;
  printingPreviewCursor: React.CSSProperties['cursor'];
  handlePrintingPreviewWheel: (event: React.WheelEvent<HTMLDivElement>) => void;
  handlePrintingPreviewPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  handlePrintingPreviewPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  handlePrintingPreviewPointerEnd: (event: React.PointerEvent<HTMLDivElement>) => void;

  printingPreviewTargetResolution: PreviewTargetResolution;
  activePrinterProfile: PrinterProfile | null | undefined;
  printingPreviewVisualTransform: string | null | undefined;

  models: React.ComponentProps<typeof PrintingLayerGpuPreview>['models'];
  supportDragGroupRef: React.RefObject<THREE.Group | null>;
  supportRenderRefreshNonce: number;
  printingPreviewScrubUpscaleTransform: string | null | undefined;

  printingPreviewPngUrlForDisplay: string | null;
  isPrintingPngLoaded: boolean;

  selectedPrintingLayerPreviewUrl: string | null;
  usePrintingSettledHiResCanvas: boolean;
  printingPreviewCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  isPrintingSettledCanvasReady: boolean;
};

/** Printing-mode right column: layer slider + GPU/PNG/settled layer preview. */
export function PrintingPreviewPane({
  printingPreviewTotalLayers,
  printingSelectedLayer,
  handlePrintingLayerChange,
  handlePrintingLayerScrubStart,
  handlePrintingLayerScrubEnd,
  printingCurrentHeightMm,
  slicingHeightMm,
  crossSectionMode,
  printingPreviewViewportRef,
  printingPreviewCursor,
  handlePrintingPreviewWheel,
  handlePrintingPreviewPointerDown,
  handlePrintingPreviewPointerMove,
  handlePrintingPreviewPointerEnd,
  printingPreviewTargetResolution,
  activePrinterProfile,
  printingPreviewVisualTransform,
  models,
  supportDragGroupRef,
  supportRenderRefreshNonce,
  printingPreviewScrubUpscaleTransform,
  printingPreviewPngUrlForDisplay,
  isPrintingPngLoaded,
  selectedPrintingLayerPreviewUrl,
  usePrintingSettledHiResCanvas,
  printingPreviewCanvasRef,
  isPrintingSettledCanvasReady,
}: PrintingPreviewPaneProps) {
  return (
    <div
      className="h-full w-1/2 min-w-0 min-h-0 grid overflow-hidden"
      style={{ gridTemplateColumns: '56px minmax(0, 1fr)', background: 'var(--surface-0)' }}
    >
      <div
        className="relative z-20 h-full overflow-visible border-r px-0 py-1.5"
        style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 6%)' }}
      >
        <LayerSlider
          min={1}
          max={Math.max(1, printingPreviewTotalLayers)}
          step={1}
          value={Math.max(1, Math.min(Math.max(1, printingPreviewTotalLayers), printingSelectedLayer))}
          onChange={handlePrintingLayerChange}
          onScrubStart={handlePrintingLayerScrubStart}
          onScrubEnd={handlePrintingLayerScrubEnd}
          allowTrackClickJump
          currentHeightMm={printingCurrentHeightMm ?? undefined}
          maxHeightMm={slicingHeightMm}
          showValue={true}
          crossSectionMode={crossSectionMode}
          showModeIndicator={false}
          compactMinimalRail
          dragBatchMode="raf"
          docked
          embedded
          expandToContainer
          className="mx-auto h-full"
        />
      </div>

      <div className="h-full min-h-0 min-w-0 p-3 flex flex-col gap-2 overflow-hidden">
        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Layer Preview
        </div>
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Layer {Math.max(1, Math.min(Math.max(1, printingPreviewTotalLayers), printingSelectedLayer))}/{Math.max(1, printingPreviewTotalLayers)}
        </div>

        <div
          className="relative flex-1 min-h-0 min-w-0 rounded-lg border p-2 flex items-center justify-center overflow-hidden"
          ref={printingPreviewViewportRef}
          style={{
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-1), transparent 6%)',
            cursor: printingPreviewCursor,
            touchAction: 'none',
          }}
          onWheel={handlePrintingPreviewWheel}
          onPointerDown={handlePrintingPreviewPointerDown}
          onPointerMove={handlePrintingPreviewPointerMove}
          onPointerUp={handlePrintingPreviewPointerEnd}
          onPointerCancel={handlePrintingPreviewPointerEnd}
        >
          {/* Layered preview: GPU preview (instant) underneath, PNG (higher quality) on top when loaded */}
          {(() => {
            const aspectW = printingPreviewTargetResolution
              ? printingPreviewTargetResolution.viewportWidth
              : activePrinterProfile?.buildVolumeMm?.width ?? 143;
            const aspectH = printingPreviewTargetResolution
              ? printingPreviewTargetResolution.viewportHeight
              : activePrinterProfile?.buildVolumeMm?.depth ?? 89;
            const aspectRatio = aspectW / aspectH;

            return (
              <div
                className="block rounded relative"
                style={{
                  aspectRatio: aspectRatio.toString(),
                  width: '100%',
                  maxWidth: '100%',
                  maxHeight: '100%',
                  transform: printingPreviewVisualTransform || 'none',
                  transformOrigin: 'center center',
                  willChange: 'transform',
                }}
              >
                {/* Fast scrub preview: keep mounted to avoid first-use GPU warmup hitch. */}
                {printingPreviewTotalLayers > 0 && (
                  <div
                    className="absolute inset-0 transition-opacity duration-100"
                    style={{
                      opacity: 1,
                      pointerEvents: 'none',
                    }}
                  >
                    <PrintingLayerGpuPreview
                      models={models}
                      clipZ={printingCurrentHeightMm}
                      buildPlateWidthMm={activePrinterProfile?.buildVolumeMm?.width ?? 143}
                      buildPlateDepthMm={activePrinterProfile?.buildVolumeMm?.depth ?? 89}
                      viewportWidthMm={printingPreviewTargetResolution?.viewportWidth}
                      viewportHeightMm={printingPreviewTargetResolution?.viewportHeight}
                      supportGroupRef={supportDragGroupRef as React.RefObject<THREE.Group>}
                      supportVersion={supportRenderRefreshNonce}
                      mirrorX={activePrinterProfile?.display?.mirrorX === true}
                      mirrorY={activePrinterProfile?.display?.mirrorY === true}
                      className="block w-full h-full rounded"
                      style={{
                        transform: printingPreviewScrubUpscaleTransform || 'none',
                        transformOrigin: 'center center',
                        willChange: 'transform',
                      }}
                    />
                  </div>
                )}

                {/* PNG layer on top (held briefly during scrub handoff to avoid flash). */}
                {printingPreviewPngUrlForDisplay && (
                  <div
                    className="absolute inset-0 transition-opacity duration-150"
                    style={{ opacity: isPrintingPngLoaded ? 1 : 0 }}
                  >
                    {printingPreviewTargetResolution ? (
                      <svg
                        viewBox={`0 0 ${printingPreviewTargetResolution.viewportWidth} ${printingPreviewTargetResolution.viewportHeight}`}
                        preserveAspectRatio="xMidYMid meet"
                        className="block w-full h-full rounded"
                        role="img"
                        aria-label={`Layer ${printingSelectedLayer} preview`}
                      >
                        <image
                          href={printingPreviewPngUrlForDisplay}
                          x={0}
                          y={0}
                          width={printingPreviewTargetResolution.viewportWidth}
                          height={printingPreviewTargetResolution.viewportHeight}
                          preserveAspectRatio="none"
                          style={{ imageRendering: 'pixelated' }}
                        />
                      </svg>
                    ) : (
                      <img
                        src={printingPreviewPngUrlForDisplay}
                        alt={`Layer ${printingSelectedLayer} preview`}
                        className="block rounded w-full h-full object-contain"
                        style={{ imageRendering: 'pixelated' }}
                      />
                    )}
                  </div>
                )}

                {/* Fallback message when no data available */}
                {!selectedPrintingLayerPreviewUrl && printingPreviewTotalLayers === 0 && (
                  <div
                    className="absolute inset-0 rounded border border-dashed flex items-center justify-center text-xs"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                  >
                    No preview available yet.
                  </div>
                )}
              </div>
            );
          })()}

          {selectedPrintingLayerPreviewUrl && usePrintingSettledHiResCanvas && (
            <canvas
              ref={printingPreviewCanvasRef}
              className="pointer-events-none absolute inset-0 block h-full w-full rounded transition-opacity duration-75"
              style={{
                imageRendering: 'pixelated',
                opacity: isPrintingSettledCanvasReady ? 1 : 0,
              }}
              aria-label={`Layer ${printingSelectedLayer} settled preview`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
