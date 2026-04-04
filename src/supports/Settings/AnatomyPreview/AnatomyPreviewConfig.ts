/**
 * ANATOMY PREVIEW CONFIGURATION
 * 
 * Edit this file to tune the look and feel of the Support Settings Preview window.
 * Changes here will immediately reflect in the application (hot reload).
 */

export const ANATOMY_CONFIG = {
    // -------------------------------------------------------------------------
    // SUPPORT GEOMETRY
    // -------------------------------------------------------------------------
    support: {
        // how tall the dummy support is (in mm). 
        // 12mm is chosen to look good in the small window.
        heightMm: 12,

        // Total height of the preview tip
        previewHeightMm: 15,
        // Angle of the contact cone (0 = Horizontal, -90 = Vertical)
        coneAngleDeg: -45,
    },

    // -------------------------------------------------------------------------
    // CAMERA & FRAMING
    // -------------------------------------------------------------------------
    camera: {
        // 'perspective' = Standard 3D look (things get smaller maxaway).
        // 'orthographic' = CAD/Engineering look (parallel lines, no distortion). 
        type: 'orthographic' as 'perspective' | 'orthographic',

        // Field of View (Perspective only).
        fov: 32,

        // Zoom/Framing Factor (Perspective Only).
        // 1.0 = Bounds touch the edge of the screen.
        // > 1.0 = Padding (zoomed out).
        // < 1.0 = Zoomed in (cropping).
        framingPadding: 2.0,

        // Orthographic Zoom Level (Orthographic Only).
        // Higher = Zoomed In. Lower = Zoomed Out.
        // Try values between 10 and 50.
        orthographicZoom: 20,

        // Initial Camera Position (fallback if framing fails)
        initialPosition: [0, -49.53, 10],
        initialTarget: [0, 0, 8],

        // Camera Up Vector (Z is up)
        upVector: [0, 0, 1],

        // Enable Mouse Interaction (Rotation/Zoom)
        enableInteraction: true,
    },

    // -------------------------------------------------------------------------
    // LIGHTING (Studio Setup)
    // -------------------------------------------------------------------------
    lighting: {
        // Ambient Light (Overall brightness filler)
        ambientIntensity: 1.0,

        // Main Key Light (Strongest light)
        keyLight: {
            position: [10, -10, 20],
            intensity: 1.5,
        },

        // Fill Light (Softer light from opposite side)
        fillLight: {
            position: [-10, 10, 5],
            intensity: 0.5,
        }
    },

    // -------------------------------------------------------------------------
    // RENDERING
    // -------------------------------------------------------------------------
    rendering: {
        // If true, shows transparent green/gradient preview style.
        // If false, shows opaque orange "Real Support" style.
        showAsGhostPreview: false,

        // Show the Preview Tuner Overlay
        showPreviewTuner: true,
    },

    // -------------------------------------------------------------------------
    // COLORS (Anatomy Highlight System)
    // -------------------------------------------------------------------------
    colors: {
        highlight: '#FD5290', // Pink for Active Focus
        dim: '#999999',       // Light Grey for Context
        normal: '#c8752a',    // Standard Support Orange (Default)
    }
};
