## Install

**Windows** — download the `.exe` installer, or the `.zip` if you'd rather not
install. SmartScreen will warn that the publisher is unknown: choose **More
info → Run anyway**.

**macOS** — download the `.dmg` for your Mac: `mac-arm64` for Apple Silicon
(M1 and later), `mac-x64` for Intel. Drag Forkfield to Applications.

If macOS says Forkfield "can't be verified" or "is damaged", this build wasn't
notarized — **right-click the app → Open** and confirm, or open **System
Settings → Privacy & Security** and click **Open Anyway** next to Forkfield.
Should it still refuse, clear the download quarantine:

```bash
xattr -cr /Applications/Forkfield.app
```

**Linux** — the `.AppImage` runs anywhere (`chmod +x` it first); the `.deb` is
for Debian and Ubuntu. Auto-update works for the AppImage only — deb installs
get a notification with a download link instead.

## Requirements

A Claude Code login. The Claude CLI is bundled, so there's nothing else to
install.
