Function .onVerifyInstDir
  Push $0
  Push $1

  StrLen $0 "$INSTDIR"
  IntCmp $0 7 append check append

  check:
    StrCpy $1 "$INSTDIR" 7 -7
    StrCmp $1 "WorkWeb" done append

  append:
    StrCpy $INSTDIR "$INSTDIR\WorkWeb"

  done:
    Pop $1
    Pop $0
FunctionEnd
