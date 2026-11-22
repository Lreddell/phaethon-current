Logan's combined Phaethon build, based on upstream main with PRs #23, #24, #25 and #26 included. This is a personal fork release, separate from the official Phaethon release channel.

- Fix Claude Code launch failures caused by long system instructions across operating systems.
- Recover course sign-in after transient page-load failures and add space deletion in Settings.
- Update already-imported courses in one action, show Canvas freshness in chat and allow course deletion.
- Make quizzes and flashcards with up to 100 items. Large sets are written in batches and each item is checked against the selected material.
- Consider all readable imported course files, honor source selection, and include Pages and Announcements in the source picker.
- Fix the clipped source list, normal scrolling and step positioning using the existing Study UI.
- Run Mac CI walkthroughs individually so parallel browsers do not interfere with the sidebar performance check. Existing tests and timing limits are preserved.

Download the Windows x64 `.exe`, the Mac `.dmg` for Apple Silicon (`arm64`) or Intel (`x64`), or a Linux x64 AppImage/deb. The Mac `.zip` files and `latest*.yml` files are updater assets. `SHA256SUMS.txt` contains checksums.

Mac builds without configured Apple Developer ID credentials are ad-hoc signed and not notarized. They may require macOS confirmation on first launch and manual installation of later releases. Windows builds are unsigned unless signing is configured.

The app checks this fork for updates. Application downloads do not contain your local vault or account sessions; sign into your accounts on each device.

Phaethon is developed by Jeryn Vicari and distributed under the MIT license. See the repository's LICENSE and THIRD_PARTY_NOTICES.md.
