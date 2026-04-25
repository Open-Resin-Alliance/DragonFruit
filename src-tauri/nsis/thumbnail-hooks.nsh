; NSIS installer hooks for DragonFruit.
; Referenced by bundle.windows.nsis.installerHooks in tauri.windows.conf.json.
;
; Provides:
;   - Dark-mode page backgrounds via WM_CTLCOLOR message handling
;   - VOXL thumbnail COM DLL registration
;
; Note on dark mode: NSIS MUI2 does not support dark mode natively.
; The dark appearance in the branded regions (header/sidebar) comes from
; the dark BMP images. The page content area (dialog controls) will follow
; the Windows system theme. The SetCtlColors calls below darken the outer
; installer window background as much as NSIS allows through hooks.

; ── Dark mode outer window coloring ──────────────────────────────────────────
!macro customInstall
  ; Paint the outer dialog background dark to blend with the dark header/sidebar.
  ; This affects the outer frame but not MUI inner pages.
  SetCtlColors $HWNDPARENT 0x16161E 0xE8E8F0
!macroend

; ── VOXL Thumbnail COM extension ─────────────────────────────────────────────
; The COM DLL is installed by Tauri into "$INSTDIR\resources\".
; DllRegisterServer writes to HKCU\SOFTWARE\Classes (no elevation required)
; and adds the CLSID to the Shell Extensions Approved list.

!macro NSIS_HOOK_POSTINSTALL
  ; Register the thumbnail provider (per-user, no elevation needed)
  ExecWait '"$SYSDIR\regsvr32.exe" /s "$INSTDIR\resources\dragonfruit_voxl_thumbnail_com.dll"'
  ; Notify Explorer so open windows pick up the new handler immediately
  System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$SYSDIR\regsvr32.exe" /s /u "$INSTDIR\resources\dragonfruit_voxl_thumbnail_com.dll"'
!macroend
