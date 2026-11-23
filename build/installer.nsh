!macro customUnInstall
  ${ifNot} ${isUpdated}
    # The registration is scoped to this channel and the uninstalling user.
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Unregister-ScheduledTask -TaskName ($\'${APP_ID}.scheduler.$\' + $$sid) -Confirm:$$false -ErrorAction SilentlyContinue"'
    Pop $0
    Delete "$APPDATA\${PRODUCT_NAME}\os-scheduler-enabled"
  ${endIf}
!macroend
