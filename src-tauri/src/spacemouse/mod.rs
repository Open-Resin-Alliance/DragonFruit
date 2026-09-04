//! 3DxWare navlib integration (Windows/macOS).
//!
//! The 3Dconnexion driver owns the HID puck and computes camera motion itself
//! (the navlib "navigation library" model). This module loads navlib at runtime
//! (never link-time, so the app degrades gracefully to the Gamepad-API path when
//! the driver is absent) and runs the live JS<->Rust camera bridge: JS pushes the
//! current three.js camera each frame via `spacemouse_native_sync`, navlib's
//! accessor callbacks read it and write back the navigated pose.

use serde::{Deserialize, Serialize};

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod navlib_sys;

// ─────────────────────── Diagnostic logging gate ───────────────────────
//
// navlib's callback tracing (per-frame affine / extents dumps, load-failure
// notes) is extremely chatty and only useful while actively debugging the
// integration. It is gated behind this compile-time
// flag so normal builds stay quiet; flip to `true` to bring the tracing back.
// The sole exception is the "navlib bridge started" line in `nav::start`, which
// logs unconditionally so the driver being detected is always visible.
// `dead_code` / `unused_macros`: on non-Windows/macOS targets the nav module (the
// only consumer) is compiled out, leaving these unreferenced — that's expected.
#[allow(dead_code)]
const NAV_DEBUG_LOG: bool = false;

/// `log::info!` that only fires when [`NAV_DEBUG_LOG`] is set.
#[allow(unused_macros)]
macro_rules! nav_log {
    ($($arg:tt)*) => {
        if $crate::spacemouse::NAV_DEBUG_LOG {
            log::info!($($arg)*);
        }
    };
}

/// `log::warn!` that only fires when [`NAV_DEBUG_LOG`] is set.
#[allow(unused_macros)]
macro_rules! nav_warn {
    ($($arg:tt)*) => {
        if $crate::spacemouse::NAV_DEBUG_LOG {
            log::warn!($($arg)*);
        }
    };
}

// ─────────────────────────── Live bridge types ───────────────────────────
//
// These cross the JS<->Rust boundary and are platform-independent (plain arrays,
// no navlib types), so they live at module scope and the non-Windows/macOS `sync`
// stub can echo them too.

/// Camera + scene snapshot pushed from JS once per frame.
///
/// `affine` is the camera-to-world matrix as three.js `Matrix4.elements`
/// (column-major, translation at indices 12/13/14) — passed straight through to
/// navlib, whose default layout matches.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraInput {
    pub affine: [f64; 16],
    pub fov: f32,
    pub focus_distance: f32,
    pub perspective: bool,
    /// Look-at / pivot point in world space (OrbitControls target).
    pub target: [f64; 3],
    /// Model bounding box in world space.
    pub model_min: [f64; 3],
    pub model_max: [f64; 3],
    /// Orthographic view extents in camera/eye space (min/max of the view box).
    /// navlib uses these to scale pan and to drive zoom when `perspective` is
    /// false; ignored in perspective mode. Sent as the current camera frustum.
    pub ortho_min: [f64; 3],
    pub ortho_max: [f64; 3],
}

/// navlib's latest camera output, returned to JS each frame.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NavOutput {
    /// Current camera-to-world affine (same layout as [`CameraInput::affine`]).
    pub affine: [f64; 16],
    /// Bumped whenever navlib writes a new affine; JS applies when it advances.
    pub seq: u64,
    /// navlib exclusive-control signal — true while the driver is navigating.
    pub motion: bool,
    /// Current orthographic view extents (camera space). In ortho mode navlib
    /// writes these to zoom; JS maps the box width back onto `camera.zoom`.
    pub ortho_min: [f64; 3],
    pub ortho_max: [f64; 3],
    /// Bumped whenever navlib writes new extents; JS applies zoom when it advances.
    pub extents_seq: u64,
}

#[cfg(target_os = "macos")]
fn candidate_libraries() -> Vec<String> {
    vec![
        "/Library/Frameworks/3DconnexionNavLib.framework/3DconnexionNavLib".to_string(),
        "/Library/Frameworks/3DconnexionNavLib.framework/Versions/Current/3DconnexionNavLib"
            .to_string(),
    ]
}

#[cfg(target_os = "windows")]
fn candidate_libraries() -> Vec<String> {
    // Bare name first: the loader searches PATH + system dirs, and the 3DxWare
    // installer adds its dir to PATH (confirmed: "TDxNavLib.dll" loads by name).
    let mut v = vec!["TDxNavLib.dll".to_string()];
    if let Ok(pf) = std::env::var("ProgramFiles") {
        v.push(format!(r"{pf}\3Dconnexion\3DxWare\3DxWinCore\Win64\TDxNavLib.dll"));
        v.push(format!(r"{pf}\3Dconnexion\3DxWare\3DxWinCore64\TDxNavLib.dll"));
    }
    v
}
// ─────────────────────────── Live bridge ───────────────────────────

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod nav {
    use super::candidate_libraries;
    use super::navlib_sys::*;
    use super::{CameraInput, NavOutput};
    use std::ffi::CStr;
    use std::os::raw::c_long;
    use std::sync::{Arc, Mutex, OnceLock};

    fn identity() -> [f64; 16] {
        let mut m = [0.0f64; 16];
        m[0] = 1.0;
        m[5] = 1.0;
        m[10] = 1.0;
        m[15] = 1.0;
        m
    }

    /// navlib `coordinateSystem`. Per the SDK header this is the transform **from
    /// the client's coordinate system TO navlib's** (world → navlib), NOT the other
    /// way round — navlib's canonical frame is X-right, Y-up, Z-out-of-screen, and
    /// this matrix lets us express every other property in DragonFruit's **Z-up**
    /// world. Columns are the images of the WORLD basis vectors in navlib space:
    ///   world X (right) → navlib  X   (1, 0, 0)
    ///   world Y (depth) → navlib −Z   (0, 0,−1)
    ///   world Z (up)    → navlib  Y   (0, 1, 0)   ← up maps to up
    /// Column-major (m[col*4 + row]), determinant +1 (proper rotation, no flip).
    ///
    /// This is the INVERSE (transpose) of the matrix we shipped before, which was
    /// written navlib→world and therefore mapped world-up onto navlib −Y (down).
    /// Relative orbit tolerated that (the frame cancels in a read-compose-write
    /// round-trip), but every ABSOLUTE orientation broke: the pre-defined view
    /// commands (Top/Front/Right…) came out with Y and Z swapped, and the
    /// keep-Y-up / Lock-Horizon algorithm locked the wrong axis. With up mapped
    /// correctly navlib's default front reference is already right, so the preset
    /// buttons resolve without needing an explicit `views.front`.
    ///
    /// If a specific axis ends up mirrored, flip the sign of the world-Y column
    /// (col1) — that only rotates the front/back sense, leaving up intact.
    fn coordinate_system() -> [f64; 16] {
        [
            1.0, 0.0, 0.0, 0.0, // col0: world X → navlib X (right)
            0.0, 0.0, -1.0, 0.0, // col1: world Y → navlib -Z (into screen)
            0.0, 1.0, 0.0, 0.0, // col2: world Z → navlib Y (up)
            0.0, 0.0, 0.0, 1.0, // col3: origin
        ]
    }

    /// navlib `views.front`: the orientation of DragonFruit's FRONT view, expressed
    /// in our Z-up client coordinates (navlib converts it internally via
    /// `coordinateSystem`). navlib queries this ONCE at connection creation and uses
    /// it to resolve the pre-defined view commands — Front/Back/Right/Left/Top/Bottom
    /// on the device and radial menu.
    ///
    /// DragonFruit's world is Z-up, X-right, **Y-back** (see ZUpGizmoViewcube), so
    /// the front view looks along +Y with up +Z. Columns are the front-view camera
    /// axes in world space (camera-to-world, column-major m[col*4 + row]):
    ///   camera right (X_cam) → world  X   (1, 0, 0)
    ///   camera up    (Y_cam) → world  Z   (0, 0, 1)
    ///   camera back  (Z_cam) → world −Y   (0,−1, 0)   (look dir = +Y, into screen)
    ///
    /// Without it navlib falls back to a default front rotated 90° about world X
    /// from ours, so every preset came out tilted (Front→Top, Top→Back, Right rolled
    /// upright). If a specific pair is still swapped after this, negate the world-Y
    /// (back) column — col2 here — to flip the front/back sense; the value only
    /// affects the preset buttons, nothing else.
    fn views_front() -> [f64; 16] {
        [
            1.0, 0.0, 0.0, 0.0, // col0: camera right → world X
            0.0, 0.0, 1.0, 0.0, // col1: camera up    → world Z
            0.0, -1.0, 0.0, 0.0, // col2: camera back  → world -Y (look = +Y)
            0.0, 0.0, 0.0, 1.0, // col3: origin
        ]
    }

    /// Shadow of the live scene. JS keeps the app-authoritative fields fresh each
    /// frame; navlib's callbacks read them and write `affine`/`motion` back.
    struct NavState {
        /// Camera-to-world affine (navlib column-major, translation at 12/13/14).
        affine: [f64; 16],
        /// Bumped on every navlib affine write so JS can detect fresh frames.
        seq: u64,
        model_min: PointT,
        model_max: PointT,
        fov: f32,
        focus_distance: f32,
        perspective: bool,
        target: PointT,
        /// Orthographic view extents in camera/eye space. Used by navlib to scale
        /// pan and to drive zoom while `perspective` is false.
        ortho_min: PointT,
        ortho_max: PointT,
        /// Bumped on every navlib extents write (ortho zoom).
        extents_seq: u64,
        /// navlib exclusive-control signal.
        motion: bool,
    }

    impl Default for NavState {
        fn default() -> Self {
            Self {
                affine: identity(),
                seq: 0,
                model_min: PointT { x: -10.0, y: -10.0, z: -10.0 },
                model_max: PointT { x: 10.0, y: 10.0, z: 10.0 },
                fov: 0.8,
                focus_distance: 50.0,
                perspective: true,
                target: PointT { x: 0.0, y: 0.0, z: 0.0 },
                ortho_min: PointT { x: -10.0, y: -10.0, z: -1000.0 },
                ortho_max: PointT { x: 10.0, y: 10.0, z: 1000.0 },
                extents_seq: 0,
                motion: false,
            }
        }
    }

    // Property names as NUL-terminated 'static byte strings (stable pointers).
    const P_COORDINATE_SYSTEM: &[u8] = b"coordinateSystem\0";
    const P_VIEW_AFFINE: &[u8] = b"view.affine\0";
    const P_VIEW_PERSPECTIVE: &[u8] = b"view.perspective\0";
    const P_VIEW_ROTATABLE: &[u8] = b"view.rotatable\0";
    const P_VIEW_FOV: &[u8] = b"view.fov\0";
    const P_VIEW_TARGET: &[u8] = b"view.target\0";
    const P_VIEW_FOCUS_DISTANCE: &[u8] = b"view.focusDistance\0";
    const P_MODEL_EXTENTS: &[u8] = b"model.extents\0";
    const P_SELECTION_EMPTY: &[u8] = b"selection.empty\0";
    const P_PIVOT_POSITION: &[u8] = b"pivot.position\0";
    const P_PIVOT_VISIBLE: &[u8] = b"pivot.visible\0";
    const P_MOTION: &[u8] = b"motion\0";
    const P_TRANSACTION: &[u8] = b"transaction\0";
    const P_ACTIVE: &[u8] = b"active\0";
    const P_FOCUS: &[u8] = b"focus\0";
    const P_VIEW_EXTENTS: &[u8] = b"view.extents\0";
    // Front-view reference for the pre-defined view (preset) commands.
    const P_VIEWS_FRONT: &[u8] = b"views.front\0";

    /// navlib reads a property value from the shadow.
    unsafe extern "C" fn nav_get(param: ParamT, name: PropertyT, value: *mut ValueT) -> c_long {
        if name.is_null() || value.is_null() {
            return NAVLIB_INVALID_FUNCTION;
        }
        let state = &*(param as *const Mutex<NavState>);
        let s = match state.lock() {
            Ok(s) => s,
            Err(_) => return NAVLIB_INVALID_FUNCTION,
        };
        let key = CStr::from_ptr(name).to_bytes();
        let v = &mut *value;
        match key {
            // Z-up world mapping (see `coordinate_system`): navlib assumes Y-up, so
            // this tells it how to decode our Z-up `view.affine`.
            b"coordinateSystem" => {
                v.type_ = MATRIX_TYPE;
                v.value.matrix = MatrixT { m: coordinate_system() };
            }
            // Front-view orientation used to resolve the preset view commands.
            b"views.front" => {
                v.type_ = MATRIX_TYPE;
                v.value.matrix = MatrixT { m: views_front() };
            }
            b"view.affine" => {
                v.type_ = MATRIX_TYPE;
                v.value.matrix = MatrixT { m: s.affine };
            }
            b"view.perspective" => {
                v.type_ = BOOL_TYPE;
                v.value.b = if s.perspective { 1 } else { 0 };
            }
            b"view.rotatable" => {
                v.type_ = BOOL_TYPE;
                v.value.b = 1;
            }
            b"view.fov" => {
                v.type_ = FLOAT_TYPE;
                v.value.f = s.fov;
            }
            b"view.focusDistance" => {
                v.type_ = FLOAT_TYPE;
                v.value.f = s.focus_distance;
            }
            b"view.target" => {
                v.type_ = POINT_TYPE;
                v.value.point = s.target;
            }
            b"view.extents" => {
                v.type_ = BOX_TYPE;
                v.value.box_ = BoxT {
                    min: s.ortho_min,
                    max: s.ortho_max,
                };
            }
            b"model.extents" => {
                v.type_ = BOX_TYPE;
                v.value.box_ = BoxT {
                    min: s.model_min,
                    max: s.model_max,
                };
            }
            b"selection.empty" => {
                v.type_ = BOOL_TYPE;
                v.value.b = 1; // nothing selected
            }
            // Feeding our own pivot sets pivot.user=true inside navlib, disabling
            // its internal hit-test pivot search — we hand it the OrbitControls target.
            b"pivot.position" => {
                v.type_ = POINT_TYPE;
                v.value.point = s.target;
            }
            _ => return NAVLIB_PROPERTY_NOT_FOUND,
        }
        0
    }

    /// navlib writes a new property value to the shadow (camera motion, flags).
    unsafe extern "C" fn nav_set(param: ParamT, name: PropertyT, value: *const ValueT) -> c_long {
        if name.is_null() || value.is_null() {
            return NAVLIB_INVALID_FUNCTION;
        }
        let state = &*(param as *const Mutex<NavState>);
        let mut s = match state.lock() {
            Ok(s) => s,
            Err(_) => return NAVLIB_INVALID_FUNCTION,
        };
        let key = CStr::from_ptr(name).to_bytes();
        let v = &*value;
        // navlib selects the active union member via `type_`; reading a mismatched
        // member would yield garbage (and, for a non-POD member, be UB). Every arm
        // below verifies `type_` before touching `v.value`.
        match key {
            b"view.affine" => {
                if v.type_ != MATRIX_TYPE {
                    return NAVLIB_INVALID_FUNCTION;
                }
                let m = v.value.matrix.m;
                // Reject a non-finite pose: a NaN/inf from the driver would poison
                // the three.js camera downstream (mirrors the view.extents guard).
                if !m.iter().all(|c| c.is_finite()) {
                    nav_log!("[spacemouse] affine REJECTED (non-finite)");
                    return 0;
                }
                let (dx, dy, dz) = (m[12] - s.affine[12], m[13] - s.affine[13], m[14] - s.affine[14]);
                s.affine = m;
                s.seq = s.seq.wrapping_add(1);
                let jump = (dx * dx + dy * dy + dz * dz).sqrt();
                if s.seq % 6 == 1 || jump > 1.0 {
                    nav_log!(
                        "[spacemouse] affine #{} pos\u{2248}({:.2}, {:.2}, {:.2}) \u{394}\u{2248}({:.3}, {:.3}, {:.3}) |\u{394}|\u{2248}{:.3}",
                        s.seq, m[12], m[13], m[14], dx, dy, dz, jump,
                    );
                }
            }
            b"view.extents" => {
                if v.type_ != BOX_TYPE {
                    return NAVLIB_INVALID_FUNCTION;
                }
                let b = v.value.box_;
                // Reject non-finite or degenerate boxes. navlib's ortho zoom can
                // shrink the width toward 0; a 0/NaN box poisons the camera.
                let finite = [b.min.x, b.min.y, b.max.x, b.max.y]
                    .iter()
                    .all(|v| v.is_finite());
                if !finite || (b.max.x - b.min.x).abs() < 1e-3 {
                    nav_log!(
                        "[spacemouse] extents REJECTED (finite={finite}) \
                         min=({:.3},{:.3}) max=({:.3},{:.3})",
                        b.min.x, b.min.y, b.max.x, b.max.y,
                    );
                    return 0;
                }
                s.ortho_min = b.min;
                s.ortho_max = b.max;
                s.extents_seq = s.extents_seq.wrapping_add(1);
                if s.extents_seq % 3 == 1 {
                    nav_log!(
                        "[spacemouse] extents #{} center\u{2248}({:.2},{:.2}) w\u{2248}{:.2} h\u{2248}{:.2}",
                        s.extents_seq,
                        (b.min.x + b.max.x) * 0.5,
                        (b.min.y + b.max.y) * 0.5,
                        b.max.x - b.min.x,
                        b.max.y - b.min.y,
                    );
                }
            }
            b"motion" => {
                if v.type_ != BOOL_TYPE {
                    return NAVLIB_INVALID_FUNCTION;
                }
                let m = v.value.b != 0;
                if m != s.motion {
                    s.motion = m;
                    let a = &s.affine;
                    nav_log!(
                        "[spacemouse] motion -> {m} (perspective={}, focusDistance={:.2}, extentsWidth\u{2248}{:.2})\n  \
                         right=({:.2},{:.2},{:.2}) up=({:.2},{:.2},{:.2}) fwd=({:.2},{:.2},{:.2}) pos=({:.2},{:.2},{:.2})",
                        s.perspective,
                        s.focus_distance,
                        s.ortho_max.x - s.ortho_min.x,
                        a[0], a[1], a[2],    // col0 = camera right
                        a[4], a[5], a[6],    // col1 = camera up
                        a[8], a[9], a[10],   // col2 = camera backward (+Z, toward viewer)
                        a[12], a[13], a[14], // col3 = position
                    );
                }
            }
            b"view.fov" => {
                if v.type_ != FLOAT_TYPE {
                    return NAVLIB_INVALID_FUNCTION;
                }
                s.fov = v.value.f;
            }
            // navlib may write the look-at / pivot back during navigation. JS owns
            // both (it pushes them every frame), so we validate the type and ignore
            // the value here rather than fight JS for ownership.
            b"view.target" | b"pivot.position" => {
                if v.type_ != POINT_TYPE {
                    return NAVLIB_INVALID_FUNCTION;
                }
            }
            b"transaction" => {
                if v.type_ != LONG_TYPE {
                    return NAVLIB_INVALID_FUNCTION;
                }
                // navlib brackets every motion frame with begin(N)/end(0), which
                // floods the log. Log sparsely just to confirm frames are running.
                if v.value.l != 0 && v.value.l % 30 == 1 {
                    nav_log!("[spacemouse] transaction = {} (frames running)", v.value.l);
                }
            }
            b"pivot.visible" => {}
            _ => return NAVLIB_PROPERTY_NOT_FOUND,
        }
        0
    }

    fn build_accessors(param: ParamT) -> Box<[AccessorT]> {
        let entry = |name: &'static [u8], get: bool, set: bool| AccessorT {
            name: name.as_ptr() as PropertyT,
            fn_get: if get { Some(nav_get as FnGetProperty) } else { None },
            fn_set: if set { Some(nav_set as FnSetProperty) } else { None },
            param,
        };
        vec![
            entry(P_COORDINATE_SYSTEM, true, false),
            entry(P_VIEW_AFFINE, true, true),
            entry(P_VIEW_PERSPECTIVE, true, false),
            entry(P_VIEW_ROTATABLE, true, false),
            entry(P_VIEW_FOV, true, true),
            entry(P_VIEW_TARGET, true, true),
            entry(P_VIEW_FOCUS_DISTANCE, true, false),
            // Writable: navlib drives ortho zoom by shrinking/growing the view box
            // WIDTH (Camera-mode routes pan/zoom here), which nav_set maps back onto
            // camera.zoom. The finite/floor guard in nav_set prevents a width→0→NaN
            // runaway.
            entry(P_VIEW_EXTENTS, true, true),
            // Read-only front-view reference for the preset view buttons.
            entry(P_VIEWS_FRONT, true, false),
            entry(P_MODEL_EXTENTS, true, false),
            entry(P_SELECTION_EMPTY, true, false),
            entry(P_PIVOT_POSITION, true, true),
            entry(P_PIVOT_VISIBLE, false, true),
            entry(P_MOTION, false, true),
            entry(P_TRANSACTION, false, true),
        ]
        .into_boxed_slice()
    }

    /// The persistent shadow state. Lives for the whole process so the pointer
    /// handed to navlib (`Arc::as_ptr`) stays valid across start/stop cycles, and
    /// so `sync` can update it even before a session is created.
    fn nav_state() -> &'static Arc<Mutex<NavState>> {
        static NAV_STATE: OnceLock<Arc<Mutex<NavState>>> = OnceLock::new();
        NAV_STATE.get_or_init(|| Arc::new(Mutex::new(NavState::default())))
    }

    /// Owns the live navlib instance + the accessor table it references. Dropping
    /// it calls `NlClose`. Raw pointers make it `!Send`; the asserted impl is sound
    /// because access is serialized through `SESSION` and navlib stops calling our
    /// callbacks once `NlClose` returns.
    struct NavSession {
        navlib: Navlib,
        handle: NlHandle,
        _accessors: Box<[AccessorT]>,
    }
    unsafe impl Send for NavSession {}

    impl Drop for NavSession {
        fn drop(&mut self) {
            unsafe {
                (self.navlib.nl_close)(self.handle);
            }
            nav_log!("[spacemouse] nav session closed");
        }
    }

    fn session_slot() -> &'static Mutex<Option<NavSession>> {
        static SESSION: OnceLock<Mutex<Option<NavSession>>> = OnceLock::new();
        SESSION.get_or_init(|| Mutex::new(None))
    }

    unsafe fn write_bool(nl: &Navlib, handle: NlHandle, name: &[u8], val: bool) {
        let v = ValueT {
            type_: BOOL_TYPE,
            value: ValueUnion { b: if val { 1 } else { 0 } },
        };
        let rc = (nl.nl_write_value)(handle, name.as_ptr() as PropertyT, &v);
        if rc != 0 {
            nav_warn!(
                "[spacemouse] write {} failed rc=0x{rc:X}",
                String::from_utf8_lossy(&name[..name.len() - 1])
            );
        }
    }

    pub fn start() -> Result<String, String> {
        let mut guard = session_slot()
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?;
        if guard.is_some() {
            return Ok("navlib bridge already running".into());
        }

        // Load navlib from the first working candidate path.
        let mut navlib = None;
        let mut loaded_from = String::new();
        for cand in candidate_libraries() {
            match unsafe { Navlib::load(&cand) } {
                Ok(nl) => {
                    navlib = Some(nl);
                    loaded_from = cand;
                    break;
                }
                Err(e) => nav_warn!("[spacemouse] load {cand} failed: {e}"),
            }
        }
        let navlib = navlib.ok_or_else(|| "navlib could not be loaded".to_string())?;

        let param = Arc::as_ptr(nav_state()) as ParamT;
        let accessors = build_accessors(param);

        let opts = NlCreateOptions {
            size: std::mem::size_of::<NlCreateOptions>() as u32,
            // Multi-threaded: navlib runs its own thread and invokes our callbacks
            // directly, so delivery does not depend on a message pump on the
            // (off-UI) Tauri command thread. The shadow is Mutex-guarded.
            b_multi_threaded: 1,
            options: NL_OPTION_NO_UI,
        };

        let mut handle: NlHandle = 0;
        let rc = unsafe {
            (navlib.nl_create)(
                &mut handle,
                b"DragonFruit\0".as_ptr() as *const _,
                accessors.as_ptr(),
                accessors.len(),
                &opts,
            )
        };
        if rc != 0 {
            return Err(format!("NlCreate failed rc=0x{rc:X}"));
        }

        // Mark this instance as the active 3D-mouse target with keyboard focus.
        unsafe {
            write_bool(&navlib, handle, P_ACTIVE, true);
            write_bool(&navlib, handle, P_FOCUS, true);
        }

        log::info!("[spacemouse] navlib bridge started (handle={handle}) from {loaded_from}");
        *guard = Some(NavSession {
            navlib,
            handle,
            _accessors: accessors,
        });
        Ok(loaded_from)
    }

    pub fn stop() -> Result<(), String> {
        let mut guard = session_slot()
            .lock()
            .map_err(|_| "session lock poisoned".to_string())?;
        *guard = None; // Drop closes the navlib handle.
        Ok(())
    }

    /// One frame of the bridge: fold in JS's current camera, then return navlib's
    /// latest. JS owns the camera while navlib is idle (`!motion`); during motion
    /// navlib owns `affine`, so JS's pushed affine is ignored to avoid a tug-of-war.
    pub fn sync(cam: CameraInput) -> NavOutput {
        let mut s = match nav_state().lock() {
            Ok(s) => s,
            // Poisoned lock: return an inert echo rather than panicking the command.
            Err(_) => {
                return NavOutput {
                    affine: cam.affine,
                    seq: 0,
                    motion: false,
                    ortho_min: cam.ortho_min,
                    ortho_max: cam.ortho_max,
                    extents_seq: 0,
                }
            }
        };

        // App-authoritative fields, always accepted.
        s.model_min = PointT { x: cam.model_min[0], y: cam.model_min[1], z: cam.model_min[2] };
        s.model_max = PointT { x: cam.model_max[0], y: cam.model_max[1], z: cam.model_max[2] };
        s.target = PointT { x: cam.target[0], y: cam.target[1], z: cam.target[2] };
        s.fov = cam.fov;
        s.focus_distance = cam.focus_distance;
        s.perspective = cam.perspective;

        // Camera pose + ortho extents: JS owns them only while navlib is idle;
        // during motion navlib owns them (pan/orient via affine, zoom via extents).
        if !s.motion {
            s.affine = cam.affine;
            s.ortho_min = PointT { x: cam.ortho_min[0], y: cam.ortho_min[1], z: cam.ortho_min[2] };
            s.ortho_max = PointT { x: cam.ortho_max[0], y: cam.ortho_max[1], z: cam.ortho_max[2] };
        }

        NavOutput {
            affine: s.affine,
            seq: s.seq,
            motion: s.motion,
            ortho_min: [s.ortho_min.x, s.ortho_min.y, s.ortho_min.z],
            ortho_max: [s.ortho_max.x, s.ortho_max.y, s.ortho_max.z],
            extents_seq: s.extents_seq,
        }
    }
}

// ─────────────────────────── Live-bridge commands ───────────────────────────

/// Start the live navlib bridge. Returns the path the driver loaded from on
/// success; an `Err` means the driver is absent and the caller should fall back
/// to the Gamepad-API path. Idempotent — a second call while running is a no-op.
#[tauri::command]
pub fn spacemouse_native_start() -> Result<String, String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        nav::start()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("navlib is only available on Windows/macOS".into())
    }
}

/// Tear down the live navlib bridge.
#[tauri::command]
pub fn spacemouse_native_stop() -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        nav::stop()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(())
    }
}

/// One frame of the JS<->navlib camera bridge: push the current three.js camera,
/// receive navlib's latest. Called once per animation frame while the bridge is
/// active. Inert (echoes the input) when no session exists.
#[tauri::command]
pub fn spacemouse_native_sync(cam: CameraInput) -> NavOutput {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        nav::sync(cam)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        NavOutput {
            affine: cam.affine,
            seq: 0,
            motion: false,
            ortho_min: cam.ortho_min,
            ortho_max: cam.ortho_max,
            extents_seq: 0,
        }
    }
}
