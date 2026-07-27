# Forkfield Release and Auto-Update Guide

## Overview

Forkfield uses **GitHub Releases** for distribution and **electron-updater** for automatic updates. Users download signed installers from GitHub and receive in-app notifications when updates are available.

## Quick Start: Publishing a Release

### 1. Set up the git remote (first time only)

```bash
git remote add origin https://github.com/YOUR_USERNAME/forkfield.git
git branch -M main
git push -u origin main
```

### 2. Tag and push to trigger the CI build

```bash
npm version patch  # or 'minor' or 'major'
git push origin main
git push origin v0.1.2  # or whatever version was created
```

The GitHub Actions workflow will:
- Build Forkfield on Windows, macOS, and Linux in parallel
- Sign the executables (Windows + macOS)
- Upload all artifacts to GitHub Releases
- Make them available immediately to users via auto-update

### 3. Manual release (optional)

If CI isn't set up yet, build and publish locally:

```bash
npm run build
npm run dist:win          # Windows
npx electron-builder -m  # macOS (requires Apple certs)
npx electron-builder -l  # Linux
```

Then upload the `dist/` artifacts manually to GitHub Releases.

---

## User Perspective: Auto-Updates

1. **On Launch:** Forkfield checks for updates in the background.
2. **Available:** If an update is found, a banner appears offering to download.
3. **Downloaded:** When ready, a second banner prompts "Install & Restart".
4. **Install:** User clicks the button; Forkfield quits and installs the new version.

Users can also manually check via the app (future: Settings → Check for Updates).

---

## Setup Checklist

### Essential (required for releases to work)

- [ ] GitHub repo created and `origin` remote configured locally
- [ ] `.github/workflows/release.yml` committed (already in place)
- [ ] Repo is public (so GitHub Actions can run and publish)

### Code Signing (recommended, platform-specific)

#### macOS
- [ ] Apple Developer Program membership ($99/year)
- [ ] Create App ID in Apple Developer Portal
- [ ] Generate and export Developer ID signing certificates
- [ ] Add secrets to GitHub repo:
  - `APPLE_ID`: your Apple ID email
  - `APPLE_PASSWORD`: an app-specific password
  - `APPLE_TEAM_ID`: your team ID (e.g., `ABCD123456`)
- [ ] Uncomment the `APPLE_*` env vars in `.github/workflows/release.yml`

#### Windows
- [ ] Option A (classic): Buy an Authenticode code-signing certificate ($200–400/year)
- [ ] Option B (modern): Use Microsoft Trusted Signing (~$10/month)
- [ ] Option C (skip for now): Unsigned releases get SmartScreen warnings but still work

### GitHub Secrets
The workflow uses `secrets.GITHUB_TOKEN` (auto-provided by GitHub Actions). No manual setup needed.

---

## Workflow Details

### Triggers
- Any tag push matching `v*` (e.g., `v0.1.2`, `v1.0.0`)

### Outputs
- Signed installers uploaded to GitHub Releases
- Users notified in-app; auto-update downloads the new version

### Platform-Specific Artifacts
- **Windows:** `.exe` (NSIS installer) + `.zip` (portable)
- **macOS:** `.dmg` (disk image) + `.zip` (zip archive)
- **Linux:** `.AppImage` + `.deb` (Debian package)

---

## Troubleshooting

### "GITHUB_TOKEN not found"
The token is auto-injected by GitHub Actions. If building locally:
```bash
GITHUB_TOKEN=<your_personal_access_token> npm run dist:win
```

### Builds pass but releases don't upload
- Check workflow logs in GitHub: **Actions** → **Build and Release** → latest run
- Ensure the tag matches `v*` format
- Ensure the repo is public (or Actions secret perms allow it)

### macOS notarization fails
- Verify `APPLE_ID` and `APPLE_PASSWORD` are correct
- If 2FA is on, use an app-specific password, not your main password
- Check the notarization server: https://developer.apple.com/system-status/

---

## Manual Testing (no release yet)

To test the update system locally without publishing:

```bash
npm run build
npx electron-builder --win --dir  # Builds but doesn't sign/publish
FORKFIELD_DEBUG=1 npm start
# Manually open DevTools (F12) and test update banner logic
```

---

## Environment

- **Node.js:** 20+
- **npm:** 10+
- **electron-builder:** v26+
- **electron-updater:** v6+
