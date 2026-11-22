# Logan's Phaethon builds

This public fork combines the personal fixes and features from upstream PRs [#23](https://github.com/jerynv/phaethon/pull/23), [#24](https://github.com/jerynv/phaethon/pull/24), [#25](https://github.com/jerynv/phaethon/pull/25) and [#26](https://github.com/jerynv/phaethon/pull/26). Phaethon is made by Jeryn Vicari; its MIT license and third-party notices are preserved.

The default `personal` branch contains the combined version. The upstream PR branches remain separate for review. Personal release versions are independent of upstream releases; 0.3.4 is the first combined personal release.

## Downloads

Open [Releases](https://github.com/Lreddell/phaethon-current/releases) and expand the release's Assets list.

Download `Phaethon-<version>-win-x64.exe` for a 64-bit Windows PC or laptop. Windows installers are unsigned unless a signing certificate is configured.

Releases include the installer, its updater blockmap, `latest.yml`, and `SHA256SUMS.txt`. The app uses this fork's update feed. Your vault, conversations and account sessions are not included in application downloads; configure accounts on each device.

## Included changes

- Claude Code uses a private system-prompt file to avoid operating-system launch limits.
- Course sign-in recovers from transient blank-page failures; spaces can be deleted through Settings.
- Imported courses can be updated together, with Canvas freshness shown in chat, and individual courses can be deleted.
- Quizzes and flashcards support up to 100 items, with large requests written in batches and checked against the sources.
- Study generation scans all readable imported course files, honors the selected parts, and offers Pages and Announcements in its source picker. It selects relevant excerpts within the model's context budget.
- The Study dialog scrolls normally, keeps its action buttons visible, and starts each step at the top.

## Make another release

1. Commit changes to `personal` and increase `package.json`'s version to an unused version.
2. Open this fork's **Actions > personal release > Run workflow**, using `personal`. Alternatively, push a `v<version>` tag pointing to the release commit.
3. The workflow runs the existing Windows suite with Node 22 and 24, then creates a draft and packages the Windows installer.
4. Once every build succeeds, it verifies the expected downloads, uploads checksums and publishes the release. A failed check or package leaves the release unpublished.

The workflow uses this repository's scoped `GITHUB_TOKEN`; no personal access token is built into the app. Optional signing credentials can be added as repository Actions secrets using the names documented in `.github/workflows/release.yml`.
