import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SCHEDULER_FLAG, SCHEDULER_INTERVAL, type SchedulerAction } from "../shared/os-scheduler.ts";

// COM keeps the executable path, arguments, user identity and trigger separately.
// This fixed program accepts a local application identity and executable over stdin.
const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name = $request.app + '.scheduler.' + $sid
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
$task = $folder.GetTasks(0) | Where-Object { $_.Name -eq $name } | Select-Object -First 1
if ($request.action -eq 'disable') {
  if ($task) { $folder.DeleteTask($name, 0) }
  [Console]::WriteLine('missing')
  return
}
if ($request.action -eq 'enable') {
  $definition = $scheduler.NewTask(0)
  $definition.RegistrationInfo.Description = 'Starts Phaethon in the background to check its own schedules while you are signed in.'
  $definition.Principal.UserId = $sid
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 0
  $definition.Settings.Enabled = $true
  $definition.Settings.AllowDemandStart = $true
  $definition.Settings.MultipleInstances = 2
  $definition.Settings.StartWhenAvailable = $true
  $definition.Settings.DisallowStartIfOnBatteries = $false
  $definition.Settings.StopIfGoingOnBatteries = $false
  $definition.Settings.WakeToRun = $false
  $definition.Settings.ExecutionTimeLimit = 'PT0S'
  $trigger = $definition.Triggers.Create(1)
  $trigger.StartBoundary = (Get-Date).AddMinutes($request.interval).ToString("yyyy-MM-dd'T'HH:mm:ss", [Globalization.CultureInfo]::InvariantCulture)
  $trigger.Repetition.Interval = 'PT' + $request.interval + 'M'
  $trigger.Enabled = $true
  $action = $definition.Actions.Create(0)
  $action.Path = $request.exe
  $action.Arguments = $request.flag
  $task = $folder.RegisterTaskDefinition($name, $definition, 6, $sid, $null, 3, $null)
}
if (!$task) { [Console]::WriteLine('missing'); return }
$definition = $task.Definition
if ($task.Enabled -and $definition.Actions.Count -eq 1 -and $definition.Triggers.Count -eq 1 -and
    $definition.Actions.Item(1).Path -ieq $request.exe -and $definition.Actions.Item(1).Arguments -ceq $request.flag -and
    $definition.Principal.LogonType -eq 3 -and $definition.Principal.RunLevel -eq 0 -and
    $definition.Settings.MultipleInstances -eq 2 -and $definition.Triggers.Item(1).Enabled -and
    $definition.Triggers.Item(1).Repetition.Interval -eq ('PT' + $request.interval + 'M')) {
  [Console]::WriteLine('active')
} else { [Console]::WriteLine('mismatch') }
`;

const encoded = Buffer.from(script, "utf16le").toString("base64");
type Registration = "active" | "missing" | "mismatch";

export async function windowsRegistration(appId: string, executable: string, action: SchedulerAction): Promise<Registration> {
  if (process.platform !== "win32" || !/^[a-z0-9.-]{1,120}$/.test(appId) ||
      !/^[A-Za-z]:[\\/]/.test(executable) || /[%"\x00-\x1f]/.test(executable) ||
      (action === "enable" && !fs.statSync(executable).isFile()) || path.extname(executable).toLowerCase() !== ".exe")
    throw new Error("Windows Task Scheduler needs a local Phaethon installation.");
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = await new Promise<string>((resolve, reject) => {
    const child = execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { timeout: 12_000, maxBuffer: 16_384, windowsHide: true }, (error, stdout) => {
        if (error) reject(new Error("Check that Windows Task Scheduler is available to your account."));
        else resolve(stdout.trim());
      });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ app: appId, exe: executable, action, flag: SCHEDULER_FLAG, interval: SCHEDULER_INTERVAL }));
  });
  if (result !== "active" && result !== "missing" && result !== "mismatch")
    throw new Error("Windows Task Scheduler returned an unexpected registration.");
  return result;
}
