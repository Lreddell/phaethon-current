/** Fixed STA program using the classic Outlook Object Model. Request fields are data. */
export const outlookWindowsScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Reply($data) { [Console]::WriteLine((ConvertTo-Json -InputObject $data -Depth 8 -Compress)) }
function Release($obj) { if ($obj -and [Runtime.InteropServices.Marshal]::IsComObject($obj)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($obj) } }
function Cut($s, $n) { $t = [string]$s; if ($t.Length -gt $n) { return $t.Substring(0, $n) }; return $t }
function Address($item) {
  try { $smtp = $item.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x5D01001F') } catch { $smtp = $item.SenderEmailAddress }
  return [string]$smtp
}
function Recipients($item, [int]$kind) {
  $list = $item.Recipients
  try {
    for ($i = 1; $i -le [Math]::Min($list.Count, 50); $i++) {
      $r = $list.Item($i)
      try {
        if ($r.Type -ne $kind) { continue }
        try { $address = $r.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x39FE001F') } catch { $address = $r.Address }
        Cut $address 320
      } finally { Release $r }
    }
  } finally { Release $list }
}
function Summary($item, $mailbox) {
  $date = if ($mailbox -eq 'sent') { $item.SentOn } else { $item.ReceivedTime }
  @{ id = [string]$item.EntryID; subject = (Cut $item.Subject 512); from = (Cut (Address $item) 320);
     to = @(Recipients $item 1); date = ([DateTime]$date).ToUniversalTime().ToString('o'); unread = [bool]$item.UnRead }
}

$outlook = $null; $session = $null; $accounts = $null; $selected = $null; $store = $null; $folder = $null; $items = $null; $mail = $null
try {
  $q = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  if ($q.version -ne 1 -or $q.op -notin @('accounts','list','read','send','open')) { Reply @{ error = 'protocol' }; return }
  $class = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey('Outlook.Application\CLSID')
  if (!$class) { Reply @{ error = 'not-installed' }; return }
  $class.Dispose()
  try { $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') }
  catch { Reply @{ error = 'start-classic' }; return }
  $session = $outlook.GetNamespace('MAPI')
  $accounts = $session.Accounts
  $found = [Collections.Generic.List[object]]::new()
  for ($i = 1; $i -le [Math]::Min($accounts.Count, 100); $i++) {
    $account = $accounts.Item($i)
    $delivery = $null
    try {
      $delivery = $account.DeliveryStore
      $smtp = [string]$account.SmtpAddress
      if (!$delivery -or !$smtp) { continue }
      $storeId = [string]$delivery.StoreID
      if ($q.op -eq 'accounts') { $found.Add(@{ name = (Cut $account.DisplayName 120); smtp = $smtp; store = $storeId }); continue }
      if ($storeId -ceq $q.store -and $smtp -eq $q.smtp) { $selected = $account; $account = $null; $store = $delivery; $delivery = $null; break }
    } finally { Release $delivery; Release $account }
  }
  if ($q.op -eq 'accounts') { Reply @{ value = @($found.ToArray()) }; return }
  if (!$selected) { Reply @{ error = 'account' }; return }
  if ($q.op -eq 'list') {
    $types = @{ inbox = 6; sent = 5; drafts = 16; trash = 3; junk = 23 }
    if ($types.ContainsKey([string]$q.mailbox)) { $folder = $store.GetDefaultFolder([int]$types[[string]$q.mailbox]) }
    else {
      $root = $store.GetRootFolder()
      try { $folder = $root.Folders.Item([string]$q.mailbox) } catch { } finally { Release $root }
    }
    if (!$folder) { Reply @{ error = 'folder' }; return }
    $items = $folder.Items
    $dateField = if ($q.mailbox -eq 'sent') { '[SentOn]' } else { '[ReceivedTime]' }
    $items.Sort($dateField, $true)
    for ($i = 1; $i -le [Math]::Min($items.Count, 250) -and $found.Count -lt $q.limit; $i++) {
      $mail = $items.Item($i)
      try {
        if ($mail.Class -ne 43) { continue }
        if ($null -ne $q.unread -and [bool]$mail.UnRead -ne [bool]$q.unread) { continue }
        $row = Summary $mail $q.mailbox
        if ($q.since -and [DateTimeOffset]$row.date -lt [DateTimeOffset]$q.since) { break }
        $from = if ($q.mailbox -eq 'sent') { $row.to -join ' ' } else { $row.from }
        if ($q.from -and $from.IndexOf([string]$q.from, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        if ($q.text -and ($row.subject + ' ' + $row.from).IndexOf([string]$q.text, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        $found.Add($row)
      } finally { Release $mail; $mail = $null }
    }
    Reply @{ value = @($found.ToArray()) }; return
  }
  if ($q.op -eq 'read') {
    $mail = $session.GetItemFromID([string]$q.id, [string]$q.store)
    if (!$mail -or $mail.Class -ne 43) { Reply @{ error = 'message' }; return }
    $row = Summary $mail $q.mailbox
    $row.body = Cut $mail.Body 34000; $row.truncated = ([string]$mail.Body).Length -gt 34000
    $row.cc = @(Recipients $mail 2)
    Reply @{ value = $row }; return
  }
  if ($q.replyId) {
    $original = $session.GetItemFromID([string]$q.replyId, [string]$q.store)
    try { if (!$original -or $original.Class -ne 43) { Reply @{ error = 'message' }; return }; $mail = $original.Reply() }
    finally { Release $original }
    $recipients = $mail.Recipients
    try { while ($recipients.Count -gt 0) { $recipients.Remove(1) } } finally { Release $recipients }
  } else { $mail = $outlook.CreateItem(0) }
  $mail.SendUsingAccount = $selected
  $sender = $mail.SendUsingAccount
  $senderStore = $null
  try {
    if (!$sender -or $sender.SmtpAddress -ne $q.smtp) { Reply @{ error = 'account' }; return }
    $senderStore = $sender.DeliveryStore
    if (!$senderStore -or $senderStore.StoreID -cne $q.store) { Reply @{ error = 'account' }; return }
  } finally { Release $senderStore; Release $sender }
  $mail.Subject = [string]$q.subject
  $mail.Body = [string]$q.body
  foreach ($row in $q.recipients) {
    $recipient = $mail.Recipients.Add([string]$row.address)
    try { $recipient.Type = [int]$row.type } finally { Release $recipient }
  }
  foreach ($file in $q.attachments) { $attachment = $mail.Attachments.Add([string]$file); Release $attachment }
  if ($q.op -eq 'open') { $mail.Display($false) } else { $mail.Send() }
  Reply @{ value = $true }
} catch { Reply @{ error = 'outlook-failed' } }
finally { Release $mail; Release $items; Release $folder; Release $store; Release $selected; Release $accounts; Release $session; Release $outlook }
`.trim();
