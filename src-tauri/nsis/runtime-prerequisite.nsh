!ifndef DF_RUNTIME_PREREQUISITE_NSH
!define DF_RUNTIME_PREREQUISITE_NSH

!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "${__FILEDIR__}\..\windows-resources\runtime-version.nsh"
!addplugindir /x86-unicode "${__FILEDIR__}\..\windows-resources\nsis-plugins\x86-unicode"

!define DF_VC_SCRIPTS "${__FILEDIR__}\..\..\scripts"
!define DF_VC_PLUGIN_NOTICE "${__FILEDIR__}\..\windows-resources\nsis-plugins\InetC.txt"
!define DF_VC_LICENSE_URL "https://visualstudio.microsoft.com/license-terms/vs2026-ga-visualcpp-v14-redist-runtime/"
!define DF_VC_DOWNLOAD_URL "https://aka.ms/vc14/vc_redist.x64.exe"

Var DF_VC_Sufficient
Var DF_VC_Consent
Var DF_VC_ConsentCheckbox
Var DF_VC_Passive
Var DF_VC_ExitCode
Var DF_VC_Message

; Hooks are included before Tauri's welcome/reinstall pages. Obtain consent
; and satisfy the prerequisite before those pages can remove an old install.
; PREINSTALL rechecks it, including the silent path that skips custom pages.
Page custom DF_VcConsentPage DF_VcConsentLeave

; Check the actual native x64 DLL, not the x86 registry view or a lexicographic
; version string. This also rejects an old DLL awaiting replacement on reboot.
Function DF_CheckVcRuntime
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $DF_VC_Sufficient 0
  ${IfNot} ${RunningX64}
    Goto df_vc_check_done
  ${EndIf}
  SetRegView 64
  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64" "Installed"
  SetRegView lastused
  IfErrors df_vc_check_done
  IntCmp $0 1 0 df_vc_check_done df_vc_check_done
  ${DisableX64FSRedirection}
  ClearErrors
  GetDLLVersion "$WINDIR\System32\msvcp140.dll" $0 $1
  ${EnableX64FSRedirection}
  IfErrors df_vc_check_done
  IntOp $2 $0 >> 16
  IntOp $2 $2 & 0xFFFF
  IntCmp $2 ${DF_VC_MAJOR} 0 df_vc_check_done df_vc_check_ok
  IntOp $3 $0 & 0xFFFF
  IntCmp $3 ${DF_VC_MINOR} 0 df_vc_check_done df_vc_check_ok
  IntOp $2 $1 >> 16
  IntOp $2 $2 & 0xFFFF
  IntCmp $2 ${DF_VC_BUILD} 0 df_vc_check_done df_vc_check_ok
  IntOp $3 $1 & 0xFFFF
  IntCmp $3 ${DF_VC_REVISION} df_vc_check_ok df_vc_check_done df_vc_check_ok
  df_vc_check_ok:
    StrCpy $DF_VC_Sufficient 1
  df_vc_check_done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function DF_VcConsentPage
  Call DF_CheckVcRuntime
  ${If} $DF_VC_Sufficient = 1
    Abort
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $DF_VC_Passive
  ${IfNot} ${Errors}
    StrCpy $DF_VC_Passive 1
    Call DF_EnsureVcRuntime
  ${EndIf}
  ${If} ${Silent}
    Call DF_EnsureVcRuntime
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Microsoft Visual C++ prerequisite" "A separate Microsoft download is required."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    StrCpy $DF_VC_ExitCode 1603
    StrCpy $DF_VC_Message "Unable to display Microsoft prerequisite consent. Install the x64 runtime from ${DF_VC_DOWNLOAD_URL}, then run setup again."
    Call DF_VcStop
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 40u "DragonFruit requires Microsoft Visual C++ v14 Redistributable (x64) ${DF_VC_VERSION} or newer. Setup can download the official installer directly from Microsoft and install it quietly. Administrator approval may be requested."
  Pop $0
  ${NSD_CreateLink} 0 46u 100% 12u "Read Microsoft's runtime license terms"
  Pop $0
  ${NSD_OnClick} $0 DF_VcOpenTerms
  ${NSD_CreateLabel} 0 65u 100% 25u "This is separate Microsoft software, not part of DragonFruit's AGPL license. Setup will not restart Windows automatically."
  Pop $0
  ${NSD_CreateCheckbox} 0 96u 100% 30u "I accept Microsoft's runtime license terms and agree to download and install the prerequisite."
  Pop $DF_VC_ConsentCheckbox
  ${If} $DF_VC_Consent = 1
    ${NSD_Check} $DF_VC_ConsentCheckbox
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function DF_VcOpenTerms
  Pop $0
  ExecShell "open" "${DF_VC_LICENSE_URL}"
FunctionEnd

Function DF_VcConsentLeave
  ${NSD_GetState} $DF_VC_ConsentCheckbox $DF_VC_Consent
  ${If} $DF_VC_Consent <> ${BST_CHECKED}
    MessageBox MB_OK|MB_ICONINFORMATION "Accept Microsoft's terms to download the prerequisite, or Cancel to exit setup. You can also install it yourself from ${DF_VC_DOWNLOAD_URL}."
    Abort
  ${EndIf}
  Call DF_EnsureVcRuntime
FunctionEnd

Function DF_VcStop
  DetailPrint "$DF_VC_Message"
  ; /S and Tauri's /P mode must never block on consent/error dialogs.
  ${IfNot} ${Silent}
  ${AndIf} $DF_VC_Passive <> 1
    MessageBox MB_OK|MB_ICONEXCLAMATION "$DF_VC_Message"
  ${Else}
    System::Call 'kernel32::AttachConsole(i -1)i.r0'
    ${If} $0 <> 0
      System::Call 'kernel32::GetStdHandle(i -11)p.r0'
      FileWrite $0 "$DF_VC_Message$\r$\n"
    ${EndIf}
  ${EndIf}
  SetErrorLevel $DF_VC_ExitCode
  ; Unlike a successful section return, Quit cannot reach Tauri's finish-page
  ; RunMainBinary or .onInstSuccess /R auto-launch path.
  Quit
FunctionEnd

Function DF_EnsureVcRuntime
  Call DF_CheckVcRuntime
  ${If} $DF_VC_Sufficient = 1
    Return
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $DF_VC_Passive
  ${IfNot} ${Errors}
    StrCpy $DF_VC_Passive 1
  ${EndIf}
  ${If} ${Silent}
  ${OrIf} $DF_VC_Passive = 1
  ${OrIf} $DF_VC_Consent <> 1
    StrCpy $DF_VC_ExitCode 1603
    StrCpy $DF_VC_Message "Microsoft Visual C++ x64 ${DF_VC_VERSION} or newer is required. Install it from ${DF_VC_DOWNLOAD_URL} before unattended setup, or run setup interactively to consent to the Microsoft download."
    Call DF_VcStop
  ${EndIf}

  InitPluginsDir
  File "/oname=$PLUGINSDIR\verify-windows-runtime.ps1" "${DF_VC_SCRIPTS}\verify-windows-runtime.ps1"
  File "/oname=$PLUGINSDIR\InetC.txt" "${DF_VC_PLUGIN_NOTICE}"
  Delete "$PLUGINSDIR\VC_redist.x64.exe"
  DetailPrint "Downloading the latest Microsoft Visual C++ x64 runtime (minimum ${DF_VC_VERSION})..."
  ; InetC uses WinINet TLS; NSISdl only supports HTTP. Never use /WEAKSECURITY.
  inetc::get /POPUP "Microsoft Visual C++ prerequisite" /CONNECTTIMEOUT 30 /RECEIVETIMEOUT 60 /NOCOOKIES "${DF_VC_DOWNLOAD_URL}" "$PLUGINSDIR\VC_redist.x64.exe" /END
  Pop $0
  ${If} $0 != "OK"
    Delete "$PLUGINSDIR\VC_redist.x64.exe"
    StrCpy $DF_VC_ExitCode 1603
    StrCpy $DF_VC_Message "Microsoft prerequisite download failed or was canceled: $0. DragonFruit setup cannot continue. Install the runtime from ${DF_VC_DOWNLOAD_URL}, then run setup again."
    Call DF_VcStop
  ${EndIf}

  DetailPrint "Verifying the Microsoft signature and minimum runtime version..."
  ClearErrors
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\verify-windows-runtime.ps1" -InstallerPath "$PLUGINSDIR\VC_redist.x64.exe" -MinimumVersion "${DF_VC_VERSION}"' $DF_VC_ExitCode
  ${If} ${Errors}
  ${OrIf} $DF_VC_ExitCode <> 0
    Delete "$PLUGINSDIR\VC_redist.x64.exe"
    StrCpy $DF_VC_ExitCode 1603
    StrCpy $DF_VC_Message "The Microsoft prerequisite could not be verified. Nothing downloaded will be executed. Install the runtime from ${DF_VC_DOWNLOAD_URL}, then run setup again."
    Call DF_VcStop
  ${EndIf}

  DetailPrint "Installing the verified Microsoft prerequisite (administrator approval may be requested)..."
  ; Microsoft's Burn bootstrapper requests elevation for its per-machine
  ; packages and waits for them. ExecWait observes its final result, including
  ; a declined UAC prompt. /norestart forbids an automatic reboot.
  ClearErrors
  ExecWait '"$PLUGINSDIR\VC_redist.x64.exe" /q /norestart' $DF_VC_ExitCode
  ${If} ${Errors}
    StrCpy $DF_VC_ExitCode 1603
  ${EndIf}
  Delete "$PLUGINSDIR\VC_redist.x64.exe"
  Call DF_CheckVcRuntime
  ${If} $DF_VC_ExitCode = 3010
    ; Stop before application files/COM registration and all launch callbacks.
    ; A successful runtime install is not yet a completed DragonFruit install.
    StrCpy $DF_VC_Message "Microsoft Visual C++ requires a Windows restart. DragonFruit has not been installed by this run. Restart Windows yourself, then run DragonFruit setup again."
    Call DF_VcStop
  ${EndIf}
  ${If} $DF_VC_ExitCode = 0
  ${OrIf} $DF_VC_ExitCode = 1638
    ${If} $DF_VC_Sufficient = 1
      DetailPrint "Microsoft Visual C++ x64 prerequisite is ready."
      Return
    ${EndIf}
  ${EndIf}
  StrCpy $DF_VC_Message "Microsoft prerequisite installation failed, was canceled, or did not provide the required x64 runtime (exit $DF_VC_ExitCode). Install it from ${DF_VC_DOWNLOAD_URL}, then run setup again."
  StrCpy $DF_VC_ExitCode 1603
  Call DF_VcStop
FunctionEnd

!endif
