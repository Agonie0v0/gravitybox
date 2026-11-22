; GravityBox for Windows — Self-Contained User-Level NSIS Installer
; Packs the verified staging directory (GravityBox.exe + resources/runtime/node.exe +
; resources/core + resources/gravitybox-win-helper.exe + i18n/icons/licenses).

Unicode True
SetCompressor /SOLID lzma

!ifndef APP_VERSION
  !error "APP_VERSION must be defined (e.g. /DAPP_VERSION=1.1.3)"
!endif
!ifndef APP_VI_VERSION
  !error "APP_VI_VERSION must be defined (e.g. /DAPP_VI_VERSION=1.1.3.0)"
!endif
!ifndef APP_ARCH
  !define APP_ARCH "x64"
!endif
!ifndef STAGE_DIR
  !error "STAGE_DIR must be defined"
!endif
!ifndef OUT_FILE
  !error "OUT_FILE must be defined"
!endif
!ifndef APP_ICON
  !error "APP_ICON must be defined"
!endif
!ifndef LICENSE_FILE
  !error "LICENSE_FILE must be defined"
!endif

!define APP_NAME "GravityBox"
!define APP_PUBLISHER "GravityBox Contributors"
!define APP_URL "https://github.com/Agonie0v0/gravitybox"
!define APP_EXE "GravityBox.exe"
!define REG_APP_KEY "Software\GravityBox"
!define REG_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\GravityBox"
!define REG_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "${REG_APP_KEY}" "InstallDir"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show
BrandingText "${APP_NAME} ${APP_VERSION} (${APP_ARCH})"

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "$(DESC_LaunchApp)"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSE_FILE}"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

LangString DESC_SecCore ${LANG_ENGLISH} "GravityBox desktop app, bundled Node 22 runtime, backend engine, dictionaries, and Win32 helper (required)."
LangString DESC_SecCore ${LANG_SIMPCHINESE} "GravityBox 主程序、内置 Node 22 运行时、核心后端、词典资产与 Win32 原生助手（必选）。"
LangString DESC_SecStartMenu ${LANG_ENGLISH} "Create Start Menu shortcuts for GravityBox and its uninstaller."
LangString DESC_SecStartMenu ${LANG_SIMPCHINESE} "在开始菜单创建 GravityBox 与卸载程序快捷方式。"
LangString DESC_SecDesktop ${LANG_ENGLISH} "Create a Desktop shortcut for GravityBox."
LangString DESC_SecDesktop ${LANG_SIMPCHINESE} "在桌面创建 GravityBox 快捷方式。"
LangString DESC_LaunchApp ${LANG_ENGLISH} "Launch GravityBox now"
LangString DESC_LaunchApp ${LANG_SIMPCHINESE} "立即启动 GravityBox"

VIProductVersion "${APP_VI_VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileDescription" "${APP_NAME} for Windows Setup"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "LegalCopyright" "MIT License"

Section "GravityBox (Core)" SecCore
  SectionIn RO

  ; Clean previous packaged resources on upgrade to prevent stale files
  RMDir /r "$INSTDIR\resources"

  SetOutPath "$INSTDIR"
  File /r "${STAGE_DIR}\*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${REG_APP_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${REG_APP_KEY}" "Version" "${APP_VERSION}"

  WriteRegStr HKCU "${REG_UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${REG_UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${REG_UNINSTALL_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${REG_UNINSTALL_KEY}" "URLInfoAbout" "${APP_URL}"
  WriteRegStr HKCU "${REG_UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKCU "${REG_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REG_UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${REG_UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${REG_UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REG_UNINSTALL_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${REG_UNINSTALL_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Start Menu Shortcuts" SecStartMenu
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0
SectionEnd

Section /o "Desktop Shortcut" SecDesktop
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore} $(DESC_SecCore)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartMenu} $(DESC_SecStartMenu)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} $(DESC_SecDesktop)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  ; Remove shortcuts
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  ; Remove autostart and uninstall registry entries (user data in %APPDATA%\GravityBox is preserved)
  DeleteRegValue HKCU "${REG_RUN_KEY}" "${APP_NAME}"
  DeleteRegKey HKCU "${REG_UNINSTALL_KEY}"
  DeleteRegKey HKCU "${REG_APP_KEY}"

  ; Remove installed files
  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
