; NSIS installer hooks for the VOXL thumbnail COM extension.
; Referenced by bundle.windows.nsis.installerHooks in tauri.windows.conf.json.
;
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
