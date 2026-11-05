# Releasing the desktop app

The desktop app gets updates two ways. Only one of them needs you.

| What changed | How it reaches desktop users | What you do |
| --- | --- | --- |
| Anything in the web client (`client/`), the server, the API | Every Production release. Installed apps download the new client within 15 minutes and reload at a quiet moment (`desktop/clientBundles.mjs`). | Nothing. Merge to main as usual. |
| The app itself: `desktop/`, the Electron version, packaging, icons, entitlements | A Desktop release. Installed apps check 30 seconds after launch and every 4 hours, download the new version, and install it on quit or on Restart now (`desktop/shellUpdater.mjs`). | Run **Desktop release**, test the draft, run **Desktop publish**. |

So most weeks need no desktop release at all. Pull requests that touch
`desktop/` run **Desktop check**, which packages the app on macOS and Linux,
so a broken build shows up on the pull request.

## The flow

1. **Actions → Desktop release → Run workflow** on `main`.
   - **bump**: `patch` for fixes, `minor` for new features, `major` for big
     changes. The workflow reads the last release (drafts included) and picks
     the next number, so you never type one. The very first release is
     `0.1.0`, from `desktop/package.json`.
   - **draft**: leave it ticked.
   - Leave **version** and **commit** empty. The workflow builds the commit
     www.marginchat.com runs (read from `/version.json`), so the bundled client
     always matches the live backend.
2. Wait about 20 minutes. The run's summary page links the draft release.
3. **Test the draft on your Mac** (below). Nobody else can see it: installed
   apps and marginchat.com/download only read published releases.
4. **Actions → Desktop publish → Run workflow** with the version from step 2
   (for example `0.1.1`). Installed apps pick it up within 4 hours;
   marginchat.com/download offers it within 5 minutes.

If the draft is bad, delete it on the Releases page, fix the bug, and run
step 1 again. The next run takes the next number, which is fine.

To skip testing (a tiny fix), untick **draft** in step 1 and the release goes
out straight away.

## Testing a draft on a Mac

1. Open https://github.com/jmsundin/margin-chat/releases (signed in to
   GitHub; drafts are only visible to you).
2. On the draft, download `Margin-Chat-<version>-mac-universal.dmg`.
3. Open it and drag **Margin Chat** into **Applications**. Replace the old
   copy if asked. Don't run it from the disk image: an app run from there
   can't update itself.
4. Open it from Applications.
   - Without a Developer ID (today), macOS says Apple could not verify it.
     Click **Done**, then open **System Settings → Privacy & Security**,
     scroll down to "Margin Chat was blocked" and click **Open Anyway**, then
     enter your password. You do this once per install, not per update.
   - The Terminal shortcut does the same:
     `xattr -dr com.apple.quarantine "/Applications/Margin Chat.app"`
5. Check what the release changed, plus the basics: sign in, open the vault
   folder, edit and save a note, voice typing (allow the microphone), and a
   `marginchat://open?path=/` link from Safari.
6. **Margin Chat → About Margin Chat** in the menu bar shows the version.

Updates themselves can only be tested once a release is published, because
installed apps read the latest published release. After publishing, an older
install shows the update within 4 hours, or 30 seconds after you reopen it.

## Signing (optional, later)

Releases work without signing; the cost is the one-time **Open Anyway** on
each new Mac, and on Windows the SmartScreen warning (**More info → Run
anyway**).

Mac releases are ad-hoc signed today. Because an ad-hoc signature changes
with every build, macOS may ask for the microphone and folder permissions
again after an update. A Developer ID signature fixes that and removes the
warning. To turn it on:

1. Join the Apple Developer Program ($99 a year) at
   https://developer.apple.com/programs/enroll/.
2. On your Mac, in **Xcode → Settings → Accounts → Manage Certificates**, add
   a **Developer ID Application** certificate. Then in **Keychain Access**,
   find "Developer ID Application: …", right-click → **Export**, save it as
   `developer-id.p12` with a password.
3. Make an app-specific password at https://account.apple.com (Sign-In and
   Security → App-Specific Passwords) and note your Team ID from
   https://developer.apple.com/account (Membership details).
4. In GitHub → repository **Settings → Secrets and variables → Actions → New
   repository secret**, add:
   - `MAC_CSC_LINK`: the output of `base64 -i developer-id.p12 | pbcopy`
     (it's now on your clipboard)
   - `MAC_CSC_KEY_PASSWORD`: the .p12 password
   - `APPLE_ID`: your Apple ID email
   - `APPLE_APP_SPECIFIC_PASSWORD`: the app-specific password
   - `APPLE_TEAM_ID`: the 10-character Team ID

The next Desktop release signs and notarizes the Mac app by itself (it takes
5 to 15 minutes longer). With only the two `MAC_CSC_*` secrets it signs
without notarizing, and Gatekeeper still warns.

Windows signing isn't wired up yet.

## Rules

- Version numbers only go up. Installed apps update only to a higher number,
  so the workflow refuses to reuse or lower one.
- Only **Desktop release** and **Desktop publish** make desktop releases. Don't
  create `desktop-v*` releases by hand: the app needs the
  `desktop-update.json` file the workflow writes.
- Don't delete published releases. An app that missed one still updates to
  the newest.
