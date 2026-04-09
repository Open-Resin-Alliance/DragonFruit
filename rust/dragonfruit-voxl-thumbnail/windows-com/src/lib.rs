//! Windows COM DLL implementing `IThumbnailProvider` for `.voxl` files.
//!
//! Build:
//!   cargo build --release -p dragonfruit-voxl-thumbnail-com
//!
//! Register (elevated):
//!   regsvr32 target\release\dragonfruit_voxl_thumbnail_com.dll
//!
//! Unregister:
//!   regsvr32 /u target\release\dragonfruit_voxl_thumbnail_com.dll

#![allow(non_snake_case)]

use std::cell::RefCell;
use std::ffi::c_void;

use windows::core::{implement, GUID, HRESULT};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows::Win32::System::Registry::*;
use windows::Win32::System::SystemServices::DLL_PROCESS_ATTACH;
use windows::Win32::UI::Shell::PropertiesSystem::{
    IInitializeWithStream, IInitializeWithStream_Impl,
};
use windows::Win32::UI::Shell::*;
use windows_core::{IUnknown, Interface};

// ── COM class identifier ──────────────────────────────────────────────────
// {8B4F2E3A-7C1D-4A5E-B9F0-6D2E8C3A1B5F}
const CLSID_VOXL_THUMBNAIL: GUID = GUID::from_u128(0x8B4F2E3A_7C1D_4A5E_B9F0_6D2E8C3A1B5F);

// Thumbnail handler shell extension category
// {E357FCCD-A995-4576-B01F-234630154E96}
const CATID_THUMBNAIL_HANDLER: &str = "{E357FCCD-A995-4576-B01F-234630154E96}";

const CLSID_STR: &str = "{8B4F2E3A-7C1D-4A5E-B9F0-6D2E8C3A1B5F}";

// ── Global DLL module handle ──────────────────────────────────────────────
static mut G_MODULE: HINSTANCE = HINSTANCE(std::ptr::null_mut());

#[no_mangle]
unsafe extern "system" fn DllMain(
    hinst_dll: HINSTANCE,
    reason: u32,
    _reserved: *mut c_void,
) -> BOOL {
    if reason == DLL_PROCESS_ATTACH {
        G_MODULE = hinst_dll;
    }
    TRUE
}

// ═══════════════════════════════════════════════════════════════════════════
// IThumbnailProvider + IInitializeWithStream
// ═══════════════════════════════════════════════════════════════════════════

#[implement(IThumbnailProvider, IInitializeWithStream)]
struct VoxlThumbnailProvider {
    data: RefCell<Vec<u8>>,
}

impl VoxlThumbnailProvider {
    fn new() -> Self {
        Self {
            data: RefCell::new(Vec::new()),
        }
    }
}

impl IInitializeWithStream_Impl for VoxlThumbnailProvider_Impl {
    fn Initialize(&self, pstream: Option<&IStream>, _grfmode: u32) -> windows::core::Result<()> {
        let stream = pstream.ok_or(E_INVALIDARG)?;

        let mut all_data = Vec::new();
        let mut buf = [0u8; 65_536];
        loop {
            let mut read = 0u32;
            unsafe {
                let _ = stream.Read(
                    buf.as_mut_ptr() as *mut c_void,
                    buf.len() as u32,
                    Some(&mut read),
                );
            }
            if read == 0 {
                break;
            }
            all_data.extend_from_slice(&buf[..read as usize]);
        }

        *self.data.borrow_mut() = all_data;
        Ok(())
    }
}

impl IThumbnailProvider_Impl for VoxlThumbnailProvider_Impl {
    fn GetThumbnail(
        &self,
        cx: u32,
        phbmp: *mut HBITMAP,
        pdwalpha: *mut WTS_ALPHATYPE,
    ) -> windows::core::Result<()> {
        let data = self.data.borrow();

        // Extract thumbnail PNG from VOXL
        let max = if cx > 0 && cx < 4096 { cx } else { 256 };
        let png_bytes = dragonfruit_voxl_thumbnail::extract_thumbnail_from_bytes_square(&data, max)
            .map_err(|_| windows::core::Error::from(E_FAIL))?;

        // Decode PNG → RGBA pixels
        let img = image::load_from_memory_with_format(&png_bytes, image::ImageFormat::Png)
            .map_err(|_| windows::core::Error::from(E_FAIL))?;
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();

        unsafe {
            // Create a DIB section
            let hdc = GetDC(HWND::default());
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w as i32,
                    biHeight: -(h as i32), // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0 as u32,
                    ..Default::default()
                },
                ..Default::default()
            };

            let mut bits: *mut c_void = std::ptr::null_mut();
            let hbitmap = CreateDIBSection(hdc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
                .map_err(|_| windows::core::Error::from(E_FAIL))?;
            let _ = ReleaseDC(HWND::default(), hdc);

            if bits.is_null() {
                let _ = DeleteObject(hbitmap);
                return Err(E_FAIL.into());
            }

            // Copy RGBA → pre-multiplied BGRA
            let pixel_count = (w * h) as usize;
            let dst = std::slice::from_raw_parts_mut(bits as *mut u8, pixel_count * 4);
            let src = rgba.as_raw();
            for i in 0..pixel_count {
                let si = i * 4;
                let a = src[si + 3] as u16;
                dst[si] = ((src[si + 2] as u16 * a) / 255) as u8; // B
                dst[si + 1] = ((src[si + 1] as u16 * a) / 255) as u8; // G
                dst[si + 2] = ((src[si] as u16 * a) / 255) as u8; // R
                dst[si + 3] = src[si + 3]; // A
            }

            *phbmp = hbitmap;
            *pdwalpha = WTSAT_ARGB;
        }

        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Class factory
// ═══════════════════════════════════════════════════════════════════════════

#[implement(IClassFactory)]
struct VoxlThumbnailProviderFactory;

impl IClassFactory_Impl for VoxlThumbnailProviderFactory_Impl {
    fn CreateInstance(
        &self,
        punkouter: Option<&IUnknown>,
        riid: *const GUID,
        ppvobject: *mut *mut c_void,
    ) -> windows::core::Result<()> {
        if punkouter.is_some() {
            return Err(windows::core::Error::from(CLASS_E_NOAGGREGATION));
        }

        let provider = VoxlThumbnailProvider::new();
        let unknown: IUnknown = provider.into();
        unsafe { unknown.query(riid, ppvobject) }.ok()
    }

    fn LockServer(&self, _flock: BOOL) -> windows::core::Result<()> {
        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DLL exports
// ═══════════════════════════════════════════════════════════════════════════

#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    if rclsid.is_null() || riid.is_null() || ppv.is_null() {
        return E_INVALIDARG;
    }
    *ppv = std::ptr::null_mut();

    if *rclsid != CLSID_VOXL_THUMBNAIL {
        return CLASS_E_CLASSNOTAVAILABLE;
    }

    let factory = VoxlThumbnailProviderFactory;
    let unknown: IUnknown = factory.into();
    unknown.query(riid, ppv)
}

#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    S_FALSE
}

// ── Self-registration ─────────────────────────────────────────────────────

#[no_mangle]
pub unsafe extern "system" fn DllRegisterServer() -> HRESULT {
    match register() {
        Ok(()) => S_OK,
        Err(e) => e.code(),
    }
}

#[no_mangle]
pub unsafe extern "system" fn DllUnregisterServer() -> HRESULT {
    match unregister() {
        Ok(()) => S_OK,
        Err(_) => S_OK, // best-effort
    }
}

unsafe fn get_dll_path() -> windows::core::Result<String> {
    let mut buf = [0u16; 1024];
    let len = GetModuleFileNameW(G_MODULE, &mut buf);
    if len == 0 {
        return Err(windows::core::Error::from(E_FAIL));
    }
    Ok(String::from_utf16_lossy(&buf[..len as usize]))
}

unsafe fn register() -> windows::core::Result<()> {
    let dll_path = get_dll_path()?;

    // Use HKCU\SOFTWARE\Classes — no elevation required, works for per-user
    // Tauri NSIS default installMode is "currentUser", so we must not require admin.
    let hkcu_classes = open_or_create_hkcu_classes()?;

    // HKCU\SOFTWARE\Classes\CLSID\{GUID}
    let clsid_path = format!("CLSID\\{}", CLSID_STR);
    set_registry_value_in(
        hkcu_classes,
        &clsid_path,
        None,
        "DragonFruit VOXL Thumbnail Provider",
    )?;

    // HKCU\SOFTWARE\Classes\CLSID\{GUID}\InProcServer32
    let inproc = format!("{}\\InProcServer32", clsid_path);
    set_registry_value_in(hkcu_classes, &inproc, None, &dll_path)?;
    set_registry_value_in(hkcu_classes, &inproc, Some("ThreadingModel"), "Apartment")?;

    // Register the thumbnail handler in multiple standard lookup locations.
    // Explorer may resolve via extension, ProgID, or SystemFileAssociations
    // depending on current UserChoice / association state.
    let shellex_ext = format!(".voxl\\ShellEx\\{}", CATID_THUMBNAIL_HANDLER);
    set_registry_value_in(hkcu_classes, &shellex_ext, None, CLSID_STR)?;

    let shellex_progid = format!("VoxlFile\\shellex\\{}", CATID_THUMBNAIL_HANDLER);
    set_registry_value_in(hkcu_classes, &shellex_progid, None, CLSID_STR)?;

    let shellex_system = format!(
        "SystemFileAssociations\\.voxl\\ShellEx\\{}",
        CATID_THUMBNAIL_HANDLER
    );
    set_registry_value_in(hkcu_classes, &shellex_system, None, CLSID_STR)?;

    // Windows 11 (and hardened Win10) requires the CLSID to appear in the
    // "Approved" extensions list, otherwise Explorer silently ignores it.
    set_registry_value(
        HKEY_CURRENT_USER,
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Approved",
        Some(CLSID_STR),
        "DragonFruit VOXL Thumbnail Provider",
    )?;

    let _ = RegCloseKey(hkcu_classes);
    Ok(())
}

unsafe fn unregister() -> windows::core::Result<()> {
    if let Ok(hkcu_classes) = open_or_create_hkcu_classes() {
        let clsid_path = format!("CLSID\\{}", CLSID_STR);
        let _ = delete_registry_tree(hkcu_classes, &clsid_path);

        let shellex_ext = format!(".voxl\\ShellEx\\{}", CATID_THUMBNAIL_HANDLER);
        let _ = delete_registry_tree(hkcu_classes, &shellex_ext);

        let shellex_progid = format!("VoxlFile\\shellex\\{}", CATID_THUMBNAIL_HANDLER);
        let _ = delete_registry_tree(hkcu_classes, &shellex_progid);

        let shellex_system = format!(
            "SystemFileAssociations\\.voxl\\ShellEx\\{}",
            CATID_THUMBNAIL_HANDLER
        );
        let _ = delete_registry_tree(hkcu_classes, &shellex_system);
        let _ = RegCloseKey(hkcu_classes);
    }

    // Remove from approved list
    let approved_w: Vec<u16> =
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Approved"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
    let mut hkey = HKEY::default();
    if RegOpenKeyW(
        HKEY_CURRENT_USER,
        windows::core::PCWSTR(approved_w.as_ptr()),
        &mut hkey,
    )
    .is_ok()
    {
        let name_w: Vec<u16> = CLSID_STR.encode_utf16().chain(std::iter::once(0)).collect();
        let _ = RegDeleteValueW(hkey, windows::core::PCWSTR(name_w.as_ptr()));
        let _ = RegCloseKey(hkey);
    }

    Ok(())
}

unsafe fn open_or_create_hkcu_classes() -> windows::core::Result<HKEY> {
    let subkey_w: Vec<u16> = "SOFTWARE\\Classes"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut hkey = HKEY::default();
    RegCreateKeyW(
        HKEY_CURRENT_USER,
        windows::core::PCWSTR(subkey_w.as_ptr()),
        &mut hkey,
    )
    .ok()?;
    Ok(hkey)
}

/// Write a registry value under an already-opened key (hkcu_classes).
unsafe fn set_registry_value_in(
    root: HKEY,
    subkey: &str,
    value_name: Option<&str>,
    data: &str,
) -> windows::core::Result<()> {
    let subkey_w: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let mut hkey = HKEY::default();
    RegCreateKeyW(root, windows::core::PCWSTR(subkey_w.as_ptr()), &mut hkey).ok()?;

    let value_w: Option<Vec<u16>> =
        value_name.map(|n| n.encode_utf16().chain(std::iter::once(0)).collect());
    let data_w: Vec<u16> = data.encode_utf16().chain(std::iter::once(0)).collect();
    let name_ptr = match &value_w {
        Some(v) => windows::core::PCWSTR(v.as_ptr()),
        None => windows::core::PCWSTR::null(),
    };
    RegSetValueExW(
        hkey,
        name_ptr,
        0,
        REG_SZ,
        Some(std::slice::from_raw_parts(
            data_w.as_ptr() as *const u8,
            data_w.len() * 2,
        )),
    )
    .ok()?;
    let _ = RegCloseKey(hkey);
    Ok(())
}

// ── Registry helpers ──────────────────────────────────────────────────────

unsafe fn set_registry_value(
    root: HKEY,
    subkey: &str,
    value_name: Option<&str>,
    data: &str,
) -> windows::core::Result<()> {
    let subkey_w: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let mut hkey = HKEY::default();

    RegCreateKeyW(root, windows::core::PCWSTR(subkey_w.as_ptr()), &mut hkey).ok()?;

    let value_w: Option<Vec<u16>> =
        value_name.map(|n| n.encode_utf16().chain(std::iter::once(0)).collect());
    let data_w: Vec<u16> = data.encode_utf16().chain(std::iter::once(0)).collect();

    let name_ptr = match &value_w {
        Some(v) => windows::core::PCWSTR(v.as_ptr()),
        None => windows::core::PCWSTR::null(),
    };

    RegSetValueExW(
        hkey,
        name_ptr,
        0,
        REG_SZ,
        Some(std::slice::from_raw_parts(
            data_w.as_ptr() as *const u8,
            data_w.len() * 2,
        )),
    )
    .ok()?;

    let _ = RegCloseKey(hkey);
    Ok(())
}

unsafe fn delete_registry_tree(root: HKEY, subkey: &str) -> windows::core::Result<()> {
    let subkey_w: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    RegDeleteTreeW(root, windows::core::PCWSTR(subkey_w.as_ptr())).ok()
}
