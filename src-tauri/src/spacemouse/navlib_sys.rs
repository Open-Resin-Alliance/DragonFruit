//! Minimal hand-written FFI for the 3Dconnexion navlib C API.
//!
//! Struct/enum layouts are transcribed directly from the 3DxWare SDK headers
//! `navlib.h` / `navlib_types.h` (the C — not C++ — view of the types). We
//! hand-write only the subset we use: bindgen was ruled out because the SDK
//! headers pull in `navlib_defines.h` and `siappcmd_types.h`
//! (`SiActionNodeEx_t` / `SiImage_t` + a C++ template layer) that we neither
//! have nor need — those two union members are treated as opaque pointers.
//!
//! Only compiled on Windows/macOS. The DLL/framework is resolved at runtime via
//! `libloading`, never link-time, so the app degrades gracefully to the
//! Gamepad-API path when the 3DxWare driver is absent, and no proprietary
//! library is redistributed.

#![cfg(any(target_os = "windows", target_os = "macos"))]
#![allow(dead_code)]

use std::os::raw::{c_char, c_long, c_void};

// ── propertyType_t (navlib_types.h). C enum → int (i32). ──
pub type PropertyType = i32;
pub const AUTO_TYPE: PropertyType = -2;
pub const UNKNOWN_TYPE: PropertyType = -1;
pub const VOIDPTR_TYPE: PropertyType = 0;
pub const BOOL_TYPE: PropertyType = 1;
pub const LONG_TYPE: PropertyType = 2;
pub const FLOAT_TYPE: PropertyType = 3;
pub const DOUBLE_TYPE: PropertyType = 4;
pub const POINT_TYPE: PropertyType = 5;
pub const VECTOR_TYPE: PropertyType = 6;
pub const MATRIX_TYPE: PropertyType = 7;
pub const STRING_TYPE: PropertyType = 8;
pub const ACTIONNODEEXPTR_TYPE: PropertyType = 9;
pub const PLANE_TYPE: PropertyType = 10;
pub const BOX_TYPE: PropertyType = 11;
pub const FRUSTUM_TYPE: PropertyType = 12;
pub const CSTR_TYPE: PropertyType = 13;
pub const IMAGEARRAY_TYPE: PropertyType = 14;

pub type BoolT = u32; // bool_t = uint32_t
pub type ParamT = u64; // param_t = uint64_t
pub type NlHandle = u64; // nlHandle_t = uint64_t
pub type PropertyT = *const c_char;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct PointT {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct VectorT {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct PlaneT {
    pub n: VectorT,
    pub d: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct BoxT {
    pub min: PointT,
    pub max: PointT,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct FrustumT {
    pub left: f64,
    pub right: f64,
    pub bottom: f64,
    pub top: f64,
    pub near_val: f64,
    pub far_val: f64,
}
/// 4x4 matrix. Fields m00..m33 are stored sequentially, so `m[R*4 + C] == mRC`
/// (row-major field order). Whether navlib *interprets* the buffer as row- or
/// column-major and row/column vectors is controlled by `nlOptions` at create.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MatrixT {
    pub m: [f64; 16],
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct StringT {
    pub p: *mut c_char,
    pub length: usize,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct CstrT {
    pub p: *const c_char,
    pub length: usize,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ImageArrayT {
    pub p: *const c_void, // const SiImage_t* — opaque
    pub count: usize,
}

/// The `value_t` variant union. `type_` selects the active member.
#[repr(C)]
#[derive(Clone, Copy)]
pub union ValueUnion {
    pub p: *mut c_void,
    pub b: BoolT,
    pub l: c_long,
    pub f: f32,
    pub d: f64,
    pub point: PointT,
    pub vector: VectorT,
    pub plane: PlaneT,
    pub box_: BoxT,
    pub frustum: FrustumT,
    pub matrix: MatrixT,
    pub pnode: *const c_void, // const SiActionNodeEx_t* — opaque
    pub string: StringT,
    pub cstr: CstrT,
    pub imagearray: ImageArrayT,
}

#[repr(C)]
pub struct ValueT {
    pub type_: PropertyType,
    pub value: ValueUnion,
}

// fn pointers are __cdecl; on x86-64 that is the platform C ABI → `extern "C"`.
pub type FnGetProperty =
    unsafe extern "C" fn(param: ParamT, name: PropertyT, value: *mut ValueT) -> c_long;
pub type FnSetProperty =
    unsafe extern "C" fn(param: ParamT, name: PropertyT, value: *const ValueT) -> c_long;

/// A per-property accessor/mutator pair. `fn_get`/`fn_set` may be null
/// (`None`) for write-only / read-only properties respectively.
#[repr(C)]
pub struct AccessorT {
    pub name: PropertyT,
    pub fn_get: Option<FnGetProperty>,
    pub fn_set: Option<FnSetProperty>,
    pub param: ParamT,
}

// nlOptions_t bit flags (C enum → int). Note the SDK reuses value 2 for both
// `column_vectors` and `row_major_order`; default (unset) is column-major.
pub type NlOptions = i32;
pub const NL_OPTION_NONE: NlOptions = 0;
pub const NL_OPTION_NONQUEUED_MESSAGES: NlOptions = 1;
pub const NL_OPTION_ROW_MAJOR_ORDER: NlOptions = 2;
pub const NL_OPTION_NO_UI: NlOptions = 4;

#[repr(C)]
pub struct NlCreateOptions {
    pub size: u32,
    pub b_multi_threaded: i8, // int8_t in the non-C++ header view
    pub options: NlOptions,
}

// navlib_errc_t values we care about when decoding return codes.
pub const NAVLIB_PROPERTY_NOT_FOUND: c_long = 0x201;
pub const NAVLIB_INVALID_FUNCTION: c_long = 0x202;

type NlCreateFn = unsafe extern "C" fn(
    *mut NlHandle,
    *const c_char,
    *const AccessorT,
    usize,
    *const NlCreateOptions,
) -> c_long;
type NlCloseFn = unsafe extern "C" fn(NlHandle) -> c_long;
type NlReadValueFn = unsafe extern "C" fn(NlHandle, PropertyT, *mut ValueT) -> c_long;
type NlWriteValueFn = unsafe extern "C" fn(NlHandle, PropertyT, *const ValueT) -> c_long;

/// Runtime-loaded navlib entry points. Holds the `Library` so the resolved
/// function pointers stay valid for the lifetime of this struct.
pub struct Navlib {
    _lib: libloading::Library,
    pub nl_create: NlCreateFn,
    pub nl_close: NlCloseFn,
    pub nl_read_value: NlReadValueFn,
    pub nl_write_value: NlWriteValueFn,
}

impl Navlib {
    /// # Safety
    /// Loads and runs the initializers of an external library, then transmutes
    /// resolved symbols to the signatures transcribed from the SDK headers. The
    /// caller asserts `path` refers to a genuine 3Dconnexion navlib.
    pub unsafe fn load(path: &str) -> Result<Self, libloading::Error> {
        let lib = libloading::Library::new(path)?;
        let nl_create = *lib.get::<NlCreateFn>(b"NlCreate\0")?;
        let nl_close = *lib.get::<NlCloseFn>(b"NlClose\0")?;
        let nl_read_value = *lib.get::<NlReadValueFn>(b"NlReadValue\0")?;
        let nl_write_value = *lib.get::<NlWriteValueFn>(b"NlWriteValue\0")?;
        Ok(Self {
            _lib: lib,
            nl_create,
            nl_close,
            nl_read_value,
            nl_write_value,
        })
    }
}
