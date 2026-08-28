!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
Var DataLocation
Var DataLocationInput
Var DataLocationEmpty
Var DesktopShortcut
Var DesktopShortcutInput
!endif

!ifndef BUILD_UNINSTALLER
Function DataLocationPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 30u "请选择 ymliuCaoXingAgent 的数据储存位置。账户、密码、证据和班级资料包都会保存在这里。"
  Pop $0
  ${NSD_CreateText} 0 38u 76% 13u "$DataLocation"
  Pop $DataLocationInput
  ${NSD_CreateBrowseButton} 78% 38u 22% 13u "浏览..."
  Pop $0
  ${NSD_OnClick} $0 DataLocationBrowse
  ${NSD_CreateLabel} 0 62u 100% 30u "安装位置由上一步设置；数据位置可以在软件的“项目设置”中再次修改。"
  Pop $0
  ${NSD_CreateCheckbox} 0 101u 100% 13u "创建桌面快捷方式（推荐）"
  Pop $DesktopShortcutInput
  ${NSD_SetState} $DesktopShortcutInput 1
  nsDialogs::Show
FunctionEnd

Function DataLocationBrowse
  nsDialogs::SelectFolderDialog "选择数据储存文件夹" "$DOCUMENTS"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $DataLocationInput $0
  ${EndIf}
FunctionEnd

Function ValidateDataLocationEmpty
  StrCpy $DataLocationEmpty "1"
  ClearErrors
  FindFirst $0 $1 "$DataLocation\*"
  IfErrors dataLocationEmptyDone
dataLocationFindNext:
  StrCmp $1 "." dataLocationNext
  StrCmp $1 ".." dataLocationNext
  StrCpy $DataLocationEmpty "0"
  FindClose $0
  Return
dataLocationNext:
  ClearErrors
  FindNext $0 $1
  IfErrors dataLocationEmptyClose
  Goto dataLocationFindNext
dataLocationEmptyClose:
  FindClose $0
dataLocationEmptyDone:
FunctionEnd

Function DataLocationPageLeave
  ${NSD_GetText} $DataLocationInput $DataLocation
  ${If} $DataLocation == ""
    StrCpy $DataLocation "$DOCUMENTS\ymliuCaoXingAgent-数据"
  ${EndIf}
  Call ValidateDataLocationEmpty
  ${If} $DataLocationEmpty == "0"
    MessageBox MB_ICONEXCLAMATION|MB_OK "选择目标文件夹不为空"
    Abort
  ${EndIf}
  ${NSD_GetState} $DesktopShortcutInput $DesktopShortcut
FunctionEnd
!endif

!macro customInit
  StrCpy $DataLocation "$DOCUMENTS\ymliuCaoXingAgent-数据"
  StrCpy $DesktopShortcut "1"
  IfFileExists "$APPDATA\ymliuCaoXingAgent\storage-location.txt" dataLocationReadCurrent dataLocationReadLegacy
  dataLocationReadCurrent:
    FileOpen $0 "$APPDATA\ymliuCaoXingAgent\storage-location.txt" r
    FileRead $0 $DataLocation
    FileClose $0
    Goto dataLocationPointerLoaded
  dataLocationReadLegacy:
    IfFileExists "$APPDATA\conduct-assistant\storage-location.txt" 0 dataLocationPointerLoaded
      FileOpen $0 "$APPDATA\conduct-assistant\storage-location.txt" r
      FileRead $0 $DataLocation
      FileClose $0
  dataLocationPointerLoaded:
!macroend

!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  Page custom DataLocationPageCreate DataLocationPageLeave
!macroend
!endif

!macro customInstall
  CreateDirectory "$DataLocation"
  IfSilent dataLocationPointerDone
    CreateDirectory "$APPDATA\ymliuCaoXingAgent"
    FileOpen $0 "$APPDATA\ymliuCaoXingAgent\storage-location.txt" w
    FileWrite $0 "$DataLocation$\r$\n"
    FileClose $0
  dataLocationPointerDone:
  ${If} $DesktopShortcut == 1
    CreateShortCut "$DESKTOP\ymliuCaoXingAgent.lnk" "$INSTDIR\ymliuCaoXingAgent.exe"
  ${EndIf}
!macroend

!macro customUnInstall
  Delete "$DESKTOP\ymliuCaoXingAgent.lnk"
!macroend
