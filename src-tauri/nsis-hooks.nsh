; NSIS installer hooks for Toolport.
;
; The app was renamed Conduit -> Toolport while deliberately keeping the bundle
; identifier (com.tsout.conduit) so in-place updates preserve each user's data
; directory and OS-keychain secrets. The side effect: the ORIGINAL Conduit
; installer created "Conduit" Start-menu / desktop shortcuts (with the old green
; icon) that an in-place update does not rename. Remove those stale shortcuts on
; (re)install so upgraders see "Toolport" with the porthole icon, not "Conduit".
;
; The standard install step creates the new "Toolport" shortcuts, so we only
; need to delete the leftover Conduit ones here. On a fresh install these
; Deletes are harmless no-ops.

!macro NSIS_HOOK_POSTINSTALL
  Delete "$SMPROGRAMS\Conduit.lnk"
  Delete "$DESKTOP\Conduit.lnk"
!macroend
