## Install

**Windows** — download the `.exe` installer, or the `.zip` if you'd rather not
install. SmartScreen will warn that the publisher is unknown: choose **More
info → Run anyway**.

**macOS** — download the `.dmg` for your Mac: `mac-arm64` for Apple Silicon
(M1 and later), `mac-x64` for Intel. Drag Forkfield to Applications.

Forkfield isn't signed with an Apple Developer certificate yet, so the first
launch needs one extra step: **right-click the app → Open**, then confirm. If
macOS refuses outright, open **System Settings → Privacy & Security**, scroll
to the Security section, and click **Open Anyway** next to Forkfield.

If macOS still says the app is *damaged*, the download quarantine is the cause.
Clear it:

```bash
xattr -cr /Applications/Forkfield.app
```

**Linux** — the `.AppImage` runs anywhere (`chmod +x` it first); the `.deb` is
for Debian and Ubuntu. Auto-update works for the AppImage only — deb installs
get a notification with a download link instead.

## Requirements

A Claude Code login. The Claude CLI is bundled, so there's nothing else to
install.
