!macro customUnInstall
  ${ifNot} ${isUpdated}
    # The registration is scoped to this channel and the uninstalling user.
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Unregister-ScheduledTask -TaskName ($\'${APP_ID}.scheduler.$\' + $$sid) -Confirm:$$false -ErrorAction SilentlyContinue"'
    Pop $0
    Delete "$APPDATA\${PRODUCT_NAME}\os-scheduler-enabled"
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$send = [Environment]::GetFolderPath([Environment+SpecialFolder]::SendTo); if ($$send) { $$file = [IO.Path]::Combine($$send, $\'${PRODUCT_NAME} - Import files.lnk$\'); if ([IO.File]::Exists($$file)) { $$link = (New-Object -ComObject WScript.Shell).CreateShortcut($$file); if ($$link.Arguments -ceq $\'--explorer-import$\' -and $$link.Description -ceq $\'Review selected files in Phaethon before copying them to a Space.$\' -and [IO.Path]::GetFileName($$link.TargetPath) -ieq $\'${PRODUCT_NAME}.exe$\') { [IO.File]::Delete($$file) } } }"'
    Pop $0
  ${endIf}
!macroend
