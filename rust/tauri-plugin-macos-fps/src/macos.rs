//! macOS-specific code to toggle WebKit's 60fps cap via the private `_features` API.
//!
//! WebKit has a preference `PreferPageRenderingUpdatesNear60FPSEnabled` (defaults to `true`)
//! that caps `requestAnimationFrame` at ~60fps. When disabled, the display's native refresh
//! rate is used (120Hz ProMotion, 144Hz+ external displays, etc.).
//!
//! **Note:** On macOS 26 (Tahoe) and later, Apple removed the 60fps cap entirely.
//! The preference still exists and can be toggled, but WKWebView ignores it —
//! native refresh rate is used by default. This plugin is most useful on macOS 13–15.
//!
//! The `_features` class method on `WKPreferences` returns all WebKit feature flags.
//! Each `_WKFeature` has a `.key` property. We find our target key and toggle it
//! via `_setEnabled:forFeature:` on the preferences instance.

use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2::{msg_send, sel};

const TARGET_KEY: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";

/// Toggle WebKit's 60fps preference on a WKWebView.
///
/// # Safety
///
/// `wk_webview_ptr` must be a valid pointer to a `WKWebView` instance.
/// Must be called from the main thread.
unsafe fn set_60fps_cap(wk_webview_ptr: *mut std::ffi::c_void, enabled: bool) -> bool {
    let wk_webview = wk_webview_ptr as *mut AnyObject;
    if wk_webview.is_null() {
        log::warn!("tauri-plugin-macos-fps: WKWebView pointer is null");
        return false;
    }

    // WKWebView -> configuration -> preferences
    let config: *mut AnyObject = unsafe { msg_send![wk_webview, configuration] };
    if config.is_null() {
        log::warn!("tauri-plugin-macos-fps: WKWebViewConfiguration is null");
        return false;
    }
    let preferences: *mut AnyObject = unsafe { msg_send![config, preferences] };
    if preferences.is_null() {
        log::warn!("tauri-plugin-macos-fps: WKPreferences is null");
        return false;
    }

    // Class method: [WKPreferences _features] -> NSArray<_WKFeature *> *
    let Some(wk_prefs_class) = AnyClass::get(c"WKPreferences") else {
        log::warn!("tauri-plugin-macos-fps: WKPreferences class not found");
        return false;
    };
    // Verify the private _features selector exists before calling it.
    // Without this check, msg_send! panics on unrecognized selectors, and
    // that panic crosses the FFI boundary in with_webview — causing an abort.
    let sel_features: Sel = sel!(_features);
    let responds: Bool = unsafe { msg_send![wk_prefs_class, respondsToSelector: sel_features] };
    if !responds.as_bool() {
        log::warn!(
            "tauri-plugin-macos-fps: WKPreferences does not respond to _features \
             (private API unavailable on this macOS version)"
        );
        return false;
    }

    let features: *mut AnyObject = unsafe { msg_send![wk_prefs_class, _features] };
    if features.is_null() {
        log::warn!("tauri-plugin-macos-fps: _features returned null (WebKit API may have changed)");
        return false;
    }

    let count: usize = unsafe { msg_send![features, count] };

    for i in 0..count {
        let feature: *mut AnyObject = unsafe { msg_send![features, objectAtIndex: i] };
        if feature.is_null() {
            continue;
        }
        let key: *mut AnyObject = unsafe { msg_send![feature, key] };
        if key.is_null() {
            continue;
        }

        // Compare the key string
        let key_nsstring = unsafe { &*(key as *const objc2_foundation::NSString) };
        if key_nsstring.to_string() == TARGET_KEY {
            // Verify _setEnabled:forFeature: exists on this preferences instance
            let sel_set: Sel = sel!(_setEnabled:forFeature:);
            let can_set: Bool = unsafe { msg_send![preferences, respondsToSelector: sel_set] };
            if !can_set.as_bool() {
                log::warn!(
                    "tauri-plugin-macos-fps: WKPreferences does not respond to \
                     _setEnabled:forFeature: (private API unavailable)"
                );
                return false;
            }

            let objc_bool = Bool::new(enabled);
            let _: () =
                unsafe { msg_send![preferences, _setEnabled: objc_bool, forFeature: feature] };

            if enabled {
                log::info!(
                    "tauri-plugin-macos-fps: re-enabled 60fps cap ({})",
                    TARGET_KEY
                );
            } else {
                log::info!(
                    "tauri-plugin-macos-fps: disabled 60fps cap -- high refresh rate rendering enabled ({})",
                    TARGET_KEY
                );
            }
            return true;
        }
    }

    log::warn!(
        "tauri-plugin-macos-fps: feature key '{}' not found among {} features \
         (WebKit version may not support this preference)",
        TARGET_KEY,
        count
    );
    false
}

/// Disable WebKit's 60fps cap, enabling the display's native refresh rate.
///
/// # Safety
///
/// `wk_webview_ptr` must be a valid pointer to a `WKWebView` instance.
/// Must be called from the main thread.
pub(crate) unsafe fn disable_60fps_cap(wk_webview_ptr: *mut std::ffi::c_void) -> bool {
    unsafe { set_60fps_cap(wk_webview_ptr, false) }
}

/// Re-enable WebKit's 60fps cap.
///
/// # Safety
///
/// `wk_webview_ptr` must be a valid pointer to a `WKWebView` instance.
/// Must be called from the main thread.
pub(crate) unsafe fn enable_60fps_cap(wk_webview_ptr: *mut std::ffi::c_void) -> bool {
    unsafe { set_60fps_cap(wk_webview_ptr, true) }
}
