import fs from "node:fs";
import type { WindowAction } from "../../shared/window-automation.ts";
import { nativeEnvironment, runNative, windowsPowerShell } from "./native-process.ts";
import { IntegrationFailure } from "./registry.ts";

export type NativeWindow = { handle: string; pid: number; started: string; app: string; title: string };
export type NativeControl = { runtime: string; automationId: string; role: string; name: string; depth: number; actions: WindowAction[] };
export type NativeInspection = { controls: NativeControl[]; truncated: boolean };
type NativeRequest = { kind: "list" } | { kind: "inspect"; window: NativeWindow }
  | { kind: "apply"; window: NativeWindow; control: NativeControl; action: WindowAction; value?: string };
export type NativeWindowAutomation = {
  available(): boolean;
  list(signal: AbortSignal): Promise<NativeWindow[]>;
  inspect(window: NativeWindow, signal: AbortSignal): Promise<NativeInspection>;
  apply(request: Extract<NativeRequest, { kind: "apply" }>, signal: AbortSignal): Promise<void>;
};

const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class PhaethonWindowSafety {
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h,int index,StringBuilder value,int size,out int needed);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint type);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token,int kind,out int value,int length,out int returned);
  public static bool Desktop() {
    IntPtr h=OpenInputDesktop(0,false,1);
    if(h==IntPtr.Zero) return false;
    try {
      int needed;
      var name=new StringBuilder(256);
      return GetUserObjectInformation(h,2,name,name.Capacity*2,out needed) && String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase);
    } finally { CloseDesktop(h); }
  }
  public static bool Window(IntPtr h,int processId) {
    uint found;
    if(h==IntPtr.Zero || !IsWindowVisible(h) || GetAncestor(h,2)!=h ||
       GetWindowThreadProcessId(h,out found)==0 || found!=processId || !Environment.UserInteractive) return false;
    using(var target=Process.GetProcessById(processId))
    using(var own=Process.GetCurrentProcess()) {
      if(target.SessionId!=own.SessionId || own.SessionId==0) return false;
    }
    IntPtr process=OpenProcess(0x1000,false,found);
    if(process==IntPtr.Zero) return false;
    try {
      IntPtr token;
      if(!OpenProcessToken(process,8,out token)) return false;
      try {
        int elevated,length;
        if(!GetTokenInformation(token,20,out elevated,4,out length) || elevated!=0) return false;
        using(var target=new WindowsIdentity(token))
        using(var own=WindowsIdentity.GetCurrent()) {
          return target.User!=null && target.User.Equals(own.User);
        }
      } finally { CloseHandle(token); }
    } finally { CloseHandle(process); }
  }
}
'@

function Send($result) { [Console]::WriteLine((ConvertTo-Json -InputObject $result -Depth 12 -Compress)) }
function Clean([string]$text, [int]$cap) {
  $text = $text -replace '[\x00-\x1f\x7f]', ' '
  return $text.Substring(0,[Math]::Min($cap,$text.Length))
}
function Identify($element) {
  try {
    $view = $element.Current
    $h = [IntPtr]([long]$view.NativeWindowHandle)
    $p = Get-Process -Id $view.ProcessId -ErrorAction Stop
    if ($view.IsPassword -or $view.IsOffscreen -or $p.ProcessName -match '^(Phaethon|electron|codex|ChatGPT|powershell|pwsh|cmd|WindowsTerminal|OpenConsole|conhost|Taskmgr|mmc|consent|CredentialUIBroker|LogonUI|LockApp|SystemSettings|SecurityHealth)' -or
        -not [PhaethonWindowSafety]::Window($h,$p.Id)) { return }
    $title = Clean $view.Name 180
    if (!$title -or $title -eq 'Program Manager' -or $title -match '(?i)password|credential|sign in|log[ -]?in|authentication|user account control') { return }
    return @{handle=$h.ToInt64().ToString(); pid=$p.Id; started=$p.StartTime.ToUniversalTime().Ticks.ToString(); app=(Clean $p.ProcessName 100); title=$title}
  } catch { return }
}

if (-not [PhaethonWindowSafety]::Desktop()) { Send @{error='desktop'}; return }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
if ($request.kind -eq 'list') {
  $results = New-Object 'Collections.Generic.List[object]'
  $node = $walker.GetFirstChild([System.Windows.Automation.AutomationElement]::RootElement)
  for ($i=0; $node -and $i -lt 180 -and $results.Count -lt 40; $i++) {
    $identity = Identify $node
    if ($identity) { $results.Add($identity) }
    $node = $walker.GetNextSibling($node)
  }
  Send @{windows=$results.ToArray()}
  return
}
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$request.window.handle))
function SameWindow($candidate) {
  return $candidate -and $candidate.handle -ceq $request.window.handle -and $candidate.pid -eq $request.window.pid -and
    $candidate.started -ceq $request.window.started -and $candidate.app -ceq $request.window.app -and $candidate.title -ceq $request.window.title
}
$observed = Identify $root
if (-not (SameWindow $observed)) {
  Send @{error='stale-window'}
  return
}

$controls = New-Object 'Collections.Generic.List[object]'
$script:remaining = 240
$script:truncated = $false
$script:target = $null
function Inspect($element, [int]$depth) {
  if (!$element -or $script:target) { return }
  if ($script:remaining -le 0 -or $depth -gt 16) { $script:truncated = $true; return }
  $script:remaining--
  $view = $element.Current
  if ($view.IsPassword -or $view.ProcessId -ne $observed.pid) { return }
  $selector = ($element.GetRuntimeId() -join '.')
  $role = $view.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  # Providers that only expose an unclassified pane cannot tell us whether its text is protected.
  $name = if ($role -in @('Pane','Custom','Unknown')) { '' } else { Clean $view.Name 180 }
  $id = Clean $view.AutomationId 180
  $available = New-Object 'Collections.Generic.List[string]'
  if ($view.IsEnabled -and !$view.IsOffscreen) {
    $pattern = $null
    if ($role -in @('Button','Hyperlink','MenuItem') -and $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { $available.Add('invoke') }
    $pattern = $null
    if ($role -eq 'Edit' -and $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern) -and !$pattern.Current.IsReadOnly) { $available.Add('set-value') }
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern,[ref]$pattern) -and $pattern.Current.VerticallyScrollable) {
      $available.Add('scroll-up')
      $available.Add('scroll-down')
    }
  }
  if ($selector -and ($name -or $available.Count -gt 0)) {
    if ($request.kind -eq 'inspect') {
      $controls.Add(@{runtime=$selector; automationId=$id; name=$name; role=$role; depth=$depth; actions=$available.ToArray()})
    } elseif ($selector -ceq $request.control.runtime -and $id -ceq $request.control.automationId -and $name -ceq $request.control.name -and
        $role -ceq $request.control.role -and $available.Contains([string]$request.action)) {
      $script:target = $element
      return
    }
  }
  $node = $walker.GetFirstChild($element)
  while ($node -and !$script:target -and $script:remaining -gt 0) {
    Inspect $node ($depth+1)
    $node = $walker.GetNextSibling($node)
  }
  if ($node -and $script:remaining -le 0) { $script:truncated = $true }
}

Inspect $root 0
if ($request.kind -eq 'inspect') { Send @{controls=$controls.ToArray(); truncated=$script:truncated}; return }
if (!$script:target -or -not (SameWindow (Identify $root)) -or -not [PhaethonWindowSafety]::Desktop()) {
  Send @{error='stale-control'}
  return
}
$current = $script:target.Current
$currentRole = $current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
$currentName = if ($currentRole -in @('Pane','Custom','Unknown')) { '' } else { Clean $current.Name 180 }
if ($current.IsPassword -or $current.IsOffscreen -or !$current.IsEnabled -or $current.ProcessId -ne $observed.pid -or
    ($script:target.GetRuntimeId() -join '.') -cne $request.control.runtime -or
    $currentName -cne $request.control.name -or (Clean $current.AutomationId 180) -cne $request.control.automationId -or
    $currentRole -cne $request.control.role) {
  Send @{error='stale-control'}
  return
}
switch ($request.action) {
  'invoke' { $script:target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  'set-value' { $script:target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$request.value) }
  'scroll-up' { $script:target.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern).Scroll('NoAmount','SmallDecrement') }
  'scroll-down' { $script:target.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern).Scroll('NoAmount','SmallIncrement') }
  default { throw 'Unsupported control pattern' }
}
Send @{applied=$true}
`;

const encoded = Buffer.from(script, "utf16le").toString("base64");

async function request<T>(input: NativeRequest, signal: AbortSignal): Promise<T> {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(9000)]);
  try {
    const raw = await runNative(windowsPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-MTA", "-EncodedCommand", encoded],
      JSON.stringify(input), lifetime, { env: nativeEnvironment() });
    const result = JSON.parse(raw) as T & { error?: string };
    if (result.error === "desktop") throw new IntegrationFailure("restricted", "Windows UI Automation needs an unlocked interactive desktop.");
    if (result.error === "stale-window") throw new IntegrationFailure("restricted", "The selected window changed. Select it again to continue.");
    if (result.error === "stale-control") throw new IntegrationFailure("restricted", "The selected control changed or cannot perform this action. Inspect the window again.");
    return result;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof IntegrationFailure) throw error;
    throw new IntegrationFailure("offline", input.kind === "apply"
      ? "Windows didn’t confirm the control action. Inspect the target before trying again."
      : "Windows could not read accessible controls. Check that the target is open and running without elevation.");
  }
}

export const windowsAutomation: NativeWindowAutomation = {
  available: () => process.platform === "win32" && fs.existsSync(windowsPowerShell()),
  list: async (signal) => (await request<{ windows: NativeWindow[] }>({ kind: "list" }, signal)).windows,
  inspect: (window, signal) => request({ kind: "inspect", window }, signal),
  apply: async (input, signal) => {
    const outcome = await request<{ applied?: boolean }>(input, signal);
    if (!outcome.applied) throw new IntegrationFailure("offline", "Windows didn’t confirm the control action.");
  },
};
