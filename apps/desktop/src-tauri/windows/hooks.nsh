; Tauri's NSIS hooks (tauri.windows-release.conf.json's `installerHooks`).

; The app writes this value on every launch so its server starts at sign-in
; (launchd.rs `start_at_login`). Left behind, Windows would try to start a
; binary the uninstall just removed.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Dray"
!macroend
