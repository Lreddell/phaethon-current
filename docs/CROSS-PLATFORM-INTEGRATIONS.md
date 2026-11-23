# Cross-platform integrations

## Architecture decision

Phaethon’s Node core owns account selection, space grants, provider operations, and the outbox. Each integration domain defines its own typed contract and uses a common provider registry. Electron main owns native file selection, opening the browser for sign-in, and desktop status presentation. The renderer configures connections and asks the user to approve actions through the existing RPC boundary. Native helpers are bounded child processes, with arguments and input kept separate.

This keeps Electron and provider-specific SDKs out of the agent tool interface. Mail uses native application APIs where a local profile exists and delegated Microsoft Graph access for cloud mail. Workflow registration uses a native file picker and runs the reviewed file with its native shell. Agents cannot register or run these scripts.

## Capability matrix

| Capability | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Microsoft mailbox | Graph | Graph | Graph |
| Calendar | Microsoft Graph and Google Calendar API | Microsoft Graph and Google Calendar API | Microsoft Graph and Google Calendar API |
| File search | Windows Search and bounded Space search | Spotlight and bounded Space search | Bounded Space search |
| Native mail app | Running classic Outlook profile | Apple Mail and legacy Outlook with Automation permission | — |
| Workflows | Registered PowerShell scripts and attended Power Automate launch | Apple Shortcuts with existing per-space grants | Registered `/bin/sh` scripts |
| Dictation | Local whisper.cpp and Windows voice typing | Local whisper.cpp and system dictation | Local whisper.cpp and desktop input method, where installed |
| Background status | Tray, taskbar overlay and notifications | Menu bar, Dock and notifications | Tray and notifications where supported by the desktop |
| Background relaunch for scheduled tasks | Optional Windows Task Scheduler registration | Schedules while the app runs | Schedules while the app runs |

Dedicated Gmail and IMAP/SMTP sign-in, macOS and Linux scheduled relaunch, Explorer integration, and Windows UI Automation remain open.

## Connect Microsoft mail

1. In Microsoft Entra, use a public client application registration that supports the account type you plan to connect. Add `http://localhost/oauth/callback` under **Mobile and desktop applications**. The port is assigned locally at sign-in. Configure delegated Microsoft Graph permissions for the operations you need. A tenant may require administrator consent. [Microsoft desktop app registration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration) and [redirect URI restrictions](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url).
2. In **Settings → Mail & connectors**, enter the Entra application ID under **Microsoft Graph** and select **Connect**. Finish in the browser. Initial consent requests `Mail.Read` and allows account-scoped searches and reads. The display address comes from the Microsoft sign-in identity and may be the account’s UPN.
3. Assign the account to each space that needs it. **Enable sending** on the connection requests `Mail.Send`. **Enable mailbox drafts** requests `Mail.ReadWrite` and lets you save a copy to the Microsoft mailbox Drafts folder. Enable sending in Phaethon’s mail settings as well. [Microsoft Graph delegated permissions](https://learn.microsoft.com/en-us/graph/permissions-reference).
4. On a draft, review the sender, recipients, body, and attachments, then press **Send**. Phaethon shows when Microsoft accepts a message. Check Sent Items for the result. Graph attachments are capped at 2.5 MB together. The threaded send path supports one original sender with no CC, BCC, or attachments. Use a new message for those cases. [Microsoft Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0).
5. Use **Reconnect** if authorization expires. **Disconnect** deletes the local token cache and removes the Phaethon space assignments for the connection. Manage tenant-level consent in Microsoft Entra.

For **Classic Outlook for Windows**, open classic Outlook and sign in to the desired profile first. In **Mail & connectors**, enable it, refresh accounts, and assign the account to a space. The adapter uses that account’s delivery store and registered sender. New Outlook does not provide the classic Outlook Object Model. Use Microsoft Graph for Microsoft mail on that client. [Microsoft’s classic and new Outlook comparison](https://support.microsoft.com/en-us/office/feature-comparison-between-new-outlook-and-classic-outlook-de453583-1e76-48bf-975a-2e9cd2ee16dd).

## Connect a calendar

In **Settings → Calendar**, enter a Microsoft Entra desktop application ID and select **Connect**. The app registration uses the same loopback redirect as Microsoft mail. Calendar sign-in has its own local connection and requests `Calendars.Read`. To add editing, configure delegated `Calendars.ReadWrite` in Entra and select **Enable editing** on the connected account. [Microsoft Graph calendar permissions](https://learn.microsoft.com/en-us/graph/permissions-reference#calendarsread).

For Google Calendar, enable the Calendar API in a Google Cloud project and configure its OAuth consent screen. Create a **Desktop app** OAuth client and download its JSON. In **Settings → Calendar → Google Calendar**, select **Choose JSON and connect** and finish sign-in in the browser. Phaethon stores the client credential and refresh token in the OS keychain. If the project is in testing mode, add the intended account as a test user. A public app may require Google verification or Workspace administrator approval. **Enable editing** starts a new consent flow for event writes. [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app) and [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

Choose an account, a calendar and a date range to see events, search the results, or check busy times. The view displays UTC and the event details show the original time zone when the provider supplies it. When editing is enabled, you can create single or weekly events with no attendees. For events you organize with no attendees, you can change the title, location and description or delete the event. Use the original calendar app to change existing times, edit recurring series, or manage invitations. Every change has a review step and creating an identical event again within 24 hours returns the earlier result. [Microsoft Graph transaction IDs](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0#properties) and [Google conditional changes](https://developers.google.com/workspace/calendar/api/guides/version-resources).

## Search within a Space

The Files view continues to search the current Space. When the local scan hits its limit, Windows Search or Spotlight can supply additional verified filenames. Phaethon’s agent can also search by filename and see the relative path, size, and modification time. Its existing content search returns line excerpts, including imported OCR text. Searches in another Space still require a folder grant. Agent search skips excluded folders and Phaethon’s state, checks symlinks and stale results, and uses the local scan whenever the system index is unavailable. Linux uses the local scan. [Windows Search index queries](https://learn.microsoft.com/en-us/windows/win32/search/using-sql-and-aqs-to-query-the-index) and [Apple Spotlight query syntax](https://developer.apple.com/library/archive/documentation/Carbon/Conceptual/SpotlightQuery/Concepts/QueryFormat.html).

## Register a local workflow

In **Settings → Automations → Registered scripts**, choose a `.ps1` file on Windows or `.sh` file on Linux. Review its path and register it. Use **Review and run** to inspect the selected script and enter a JSON object. The script receives UTF-8 JSON on standard input and returns text on standard output. Phaethon runs the script from its own directory without elevating privileges. Windows PowerShell applies its existing execution policy. [Microsoft PowerShell execution policies](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies).

For example, a PowerShell script can read input with `[Console]::In.ReadToEnd() | ConvertFrom-Json`. A shell script can consume standard input with a JSON parser it already uses. Phaethon times out after two minutes and offers **Cancel run** while a script is running. Register the file again after editing or moving it. An audit records the script name, time and completion status on this device. It omits input and output. Removing a registration leaves the file intact.

On Windows, **Settings → Automations → Power Automate for desktop** accepts the run URL from a flow’s Properties panel. The URL must contain the environment ID and flow ID. **Open flow** requests an attended run. Power Automate handles sign-in, licensing, input prompts, confirmation, cancellation and completion. Phaethon records when it requested the launch and labels it accordingly. Check the Power Automate console for the result. A real run requires a signed-in, licensed installation and access to the registered flow. [Microsoft desktop flow run URLs](https://learn.microsoft.com/en-us/power-automate/desktop-flows/run-desktop-flows-url-shortcuts).

## Relaunch for scheduled tasks

In the packaged Windows app, enable **Settings → Notifications → Relaunch for scheduled tasks** to register a per-user task for the current Phaethon installation. Windows checks every 15 minutes while that user is signed in. The task starts Phaethon without a window when it was closed. It sends a scheduler check to Phaethon if it was already running. The task does not wake a sleeping computer. Phaethon checks schedules on resume. Use **Turn off** to remove the task or **Repair** if the registration changed. A normal uninstall removes the task and its opt-in marker. [Windows Task Scheduler settings](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings).

Phaethon owns the schedules and job permissions. It runs the latest missed slot within 24 hours, skips nonexistent local times when clocks move forward, and uses the first occurrence of repeated local times. A job interrupted by a process exit is shown as interrupted and is eligible for its next slot. Existing checks for paused automations, model access and unattended operations still apply.

## Dictate a chat message locally

1. Install or extract whisper.cpp for your operating system. On Windows x64, the official CPU/BLAS archive includes `whisper-cli.exe`. Keep the executable with its required libraries. On macOS and Linux, select `whisper-cli` from a local installation or build. [whisper.cpp releases and build instructions](https://github.com/ggml-org/whisper.cpp).
2. Open **Settings → General → Voice input**. Choose and review the executable, then select **Download model**. Phaethon downloads the 32.2 MB Whisper Tiny multilingual model and checks its size and SHA-256 before activating it. Pick a spoken language or leave detection automatic. Model and engine settings are device-local. [Model source and SHA-256](https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-tiny-q5_1.bin).
3. Select **Record voice for this message** in the composer. **Stop recording** starts CPU transcription. **Cancel** discards the clip or stops a transcription in progress. A clip lasts up to 60 seconds. Review and edit the inserted text before sending it.

You can also focus the message box and use `Win+H` for Windows voice typing. The NSIS installer has no MSIX package identity, which the Windows Runtime speech recognition API requires. On macOS, system dictation remains available through its configured shortcut. [Windows speech recognition requirements](https://learn.microsoft.com/en-us/windows/apps/develop/input/speech-recognition).

## Permissions and migration

- Graph uses browser-based authorization with PKCE, state validation, and a loopback callback. Tokens stay in the OS credential store. The local metadata file records connection identifiers, display fields and granted scopes. Its namespace is scoped to the vault path and app channel. The Graph API client constrains request destinations and refuses redirects.
- Space assignments are checked before mailbox reads and again at send time. Draft approval is tied to the displayed revision. Phaethon stages the reviewed attachment contents for delivery and detects edits since approval. Timers created by earlier builds without recorded approval revert to drafts. Ambiguous send attempts remain locked and direct the user to Sent Items. Existing connector IDs and mail settings files remain readable.
- Model fallback defaults off for vaults with no saved choice. The existing setting preserves explicit choices and explains that a different connection can receive the conversation and attachments.
- File approval now binds to the reviewed destination and its filesystem identity and timestamps. If a destination appears, changes, or resolves to a different file during review, request approval again.
- Course downloads validate public addresses on off-site hops. Session cookies and cache validators stay on the configured course site. The public icon fetcher follows same-origin redirects and bounds the icon size.
- Mac course sign-in still uses the existing Chromium profile and credential storage. Changing its keychain behavior needs a migration and signed-build verification. The Graph connector uses a separate credential-store namespace.
- Registered scripts run with the current user’s permissions. Phaethon verifies the approved file’s hash before launch and passes structured input through standard input. Trust in dependencies the script loads remains with the user. Script registration is device-local. Existing Shortcuts grants and schedules retain their original storage.
- Local speech grants audio-only capture to the trusted main frame for a short window after a user click. Course-login windows keep their existing denial policy. The core accepts a bounded PCM recording, runs the selected executable, and cleans up temporary audio and output. The model download transfers model weights only. The composer receives the editable text and awaits a separate send action. [Electron media permission checks](https://www.electronjs.org/docs/latest/api/session#sessetpermissioncheckhandlerhandler).
- The installer uses the existing Electron configuration. Microsoft Graph adds a packaged JavaScript dependency. Classic Outlook and Windows PowerShell use installed OS components. The Windows tray, overlay, and icon extraction for a registered classic Outlook installation use Electron native APIs. [Electron taskbar overlay](https://www.electronjs.org/docs/latest/api/browser-window#winsetoverlayiconoverlay-description-windows), [Electron application icons](https://www.electronjs.org/docs/latest/api/app#appgetfileiconpath-options), and [Windows App Paths registration](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration).

## Verification scope

Automated coverage includes OAuth callback validation, Graph mailbox request contracts, Outlook adapter account binding, outbox approval and recovery, registered script validation and cancellation, file approval, and course-site redirects. All six mail browser tests passed with a fixture mailbox on Windows. The Windows x64 package built and launched in a disposable profile. It displayed the Graph and Outlook settings and opened the native `.ps1` picker. A separate PowerShell smoke test registered a harmless script, passed JSON through standard input, checked its response, and refused an edited script.

Live Microsoft sign-in and delivery need an Entra registration, a test mailbox, and interactive consent. Classic Outlook mailbox operations need a running classic Outlook profile and a test mailbox. Power Automate flow registration and launch requests have contract tests. A live run needs a licensed flow. Windows ARM64, macOS and Linux native packaging and smoke tests remain necessary before distributing this work.
