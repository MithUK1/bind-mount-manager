# Bind Mount Manager for Synology DSM 7

Make any folder on your Synology NAS also appear as its own SMB share, without moving or copying a single file.

For example, if your files live in `/volume1/data/media/movies`, Bind Mount Manager lets you open them as `\\NAS\movies`, as if `movies` were a top-level shared folder. The original location keeps working exactly as before.

It is a small DSM package with a point-and-click interface: pick the folder, name the new share, done. Mounts are restored automatically after every reboot.

> Not affiliated with or endorsed by Synology Inc. Use at your own risk, see [Disclaimer](#disclaimer).

---

## Contents

- [What problem does it solve?](#what-problem-does-it-solve)
- [Requirements](#requirements)
- [Installation](#installation)
- [First-time setup](#first-time-setup)
- [Using it](#using-it)
- [Permissions](#permissions)
- [How it works](#how-it-works)
- [Safety checks](#safety-checks)
- [Updating, uninstalling](#updating-and-uninstalling)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Building from source](#building-from-source)
- [Disclaimer](#disclaimer)
- [Licence](#licence)

---

## What problem does it solve?

In DSM only a registered **shared folder** can be an SMB share. A subfolder such as `data/media/movies` can be reached as `\\NAS\data\media\movies`, but it cannot be `\\NAS\movies` on its own.

The usual answers are to move the files into a new shared folder, copy them, or use symlinks (which SMB clients generally will not follow). All of them are awkward when the data is already in place and used by other apps.

A **bind mount** is the Linux feature that fixes this. It makes the same directory visible at a second location. Bind Mount Manager creates a new, empty shared folder and bind mounts your existing folder onto it. Both paths show the same files, with no duplication and no extra disk space.

## Requirements

- Synology NAS running **DSM 7.0 or later** (any CPU architecture, the package is plain shell and JavaScript).
- An account in the **administrators** group. Only administrators can open or use the app.
- The source folder and the new share must be on the **same volume** (by design, see [FAQ](#faq)).
- **Package Center > Settings > General > Trust Level** must allow packages from any publisher, because this package is not signed by Synology. Set it back afterwards if you prefer.
- DSM opened over **HTTPS** for the automatic setup (the password confirmation API only works over HTTPS).

## Installation

1. Download `BindMountManager-1.0.0.spk` from the Releases page.
2. In DSM open **Package Center > Manual Install**, browse to the file and click **Next**.
3. On the wizard page you can optionally enter your administrator name and password so the one-time setup happens during the install. Leave it blank to do it later from the app. See below for what this does.
4. Finish the wizard. **Bind Mount Manager** appears in the main menu.

## First-time setup

DSM 7 does not allow third-party packages to run as root, and mounting needs root. So the app uses a tiny **helper script** that runs as root from a **boot-up task in Task Scheduler**, which is the supported way to run a script as root on DSM. The app can create that task for you. You only do this once.

Pick one:

**A. During installation (easiest).** Enter an administrator name and password on the install wizard. The installer asks DSM to create the task and starts the helper. The password is used for that single request and then discarded. Nothing is stored.

**B. From the app.** Open Bind Mount Manager and type your DSM password into the **One-time setup** card, then click **Set up automatically**. The password is only sent to DSM to confirm the change, the same confirmation DSM asks for in Control Panel, and is never stored.

**C. Manual install.** Expand **Manual install** on the setup card and follow the steps. In short:

1. Control Panel > Task Scheduler > Create > Triggered Task > User-defined script.
2. General tab: Task `Bind Mount Manager`, User `root`, Event `Boot-up`, Enabled.
3. Task Settings tab, user-defined script:
   ```
   /bin/bash /var/packages/BindMountManager/target/bin/install-helper.sh
   ```
4. Click OK, accept the warning, then select the task and click **Run**.

When it worked, the header shows **Helper running**.

## Using it

### Add a mount

1. Click **Add mount**.
2. **Folder with your files (source):** choose the existing folder, for example `/volume1/data/media/movies`. It is never moved or changed.
3. **Name of the new share:** the NAS name is filled in for you and the folder name is suggested. Edit it if you like, for example `\\MYNAS\movies`. The name must be new on that volume.
4. Optionally tick **Read only** so people using the new share cannot change files.
5. Click **Create share and mount**.

The app creates the shared folder through DSM, bind mounts your folder onto it and shows the mount as **Active**. If your account or DSM refuses to create the share from the app, use **Use an existing empty folder instead**: create an empty shared folder yourself in Control Panel > Shared Folder and pick it as the target.

### Manage mounts

| Control | What it does |
| --- | --- |
| Switch | Turns the mount off or on without deleting it. |
| Permissions | Opens DSM's Shared Folder page in a new tab so you can set who can use the new share. |
| Remove | Unmounts and forgets the mount (click twice to confirm). The files and the empty shared folder are left alone. |

Status labels: **Active**, **Off**, **Applying**, **Waiting** (for example the volume is not ready yet) and **Problem** (hover or read the message under the mount).

## Permissions

A bind mount shows the very same files, so **file permissions are unchanged**. A user who could not read a file before cannot read it through the new share either.

DSM then adds a second check at the **share** level. A newly created shared folder starts with access for administrators only. To let others in:

1. Click **Permissions** on the mount (or go to Control Panel > Shared Folder).
2. Select the new share, click **Edit**, open the **Permissions** tab.
3. Give Read/Write (or Read only) to the users or groups who should see it.

Access is then the combination of the share permission and the existing file permissions, which is how DSM normally works. You can give different people different shares for different folders this way.

## How it works

```
 Browser (DSM desktop)
      |  HTTPS, DSM session + CSRF token
      v
 api.cgi            runs as the package user, administrators only
      |  edits mounts.conf, drops request files in a spool folder
      v
 bmm-helper         runs as root (Task Scheduler boot-up task)
      |  validates everything, then runs: mount --bind
      v
 /volume1/data/media/movies  ==appears also as==>  /volume1/movies  ==>  \\NAS\movies
```

- **Web interface** (`ui/app.js`, `ui/app.css`): a single page with no external libraries. It talks to `api.cgi` for the mount list and the folder browser, and to DSM's own web API for the actions that need a confirmed administrator password (creating the shared folder and the boot-up task).
- **`api.cgi`**: a bash CGI that runs as the package user. It checks the DSM session, requires membership of the administrators group, requires the CSRF token and a custom request header on every change, and performs only a syntax check of paths. It never mounts anything itself.
- **Configuration**: `/var/packages/BindMountManager/var/mounts.conf`, one tab-separated line per mount (id, enabled, read only, source, target). It is plain text and safe to read.
- **`bmm-helper`**: the root helper, installed to `/usr/local/bin/bmm-helper` (a root-owned copy, so the package user cannot swap it for something else). Every few seconds it compares the config with the real mounts and corrects the difference: it mounts what should be mounted, unmounts what was disabled or removed, and reports the result back to the page. It also answers folder-browsing requests, because the package user is not allowed to list every folder on the volume.
- **Communication**: the CGI and the helper only exchange small files (`/var/packages/BindMountManager/var/spool` for requests, `/run/bindmountmanager` for state and replies). There is no network port and no daemon with a socket.
- **`install-helper.sh`**: what the boot-up task runs. It copies the helper to the root-owned location (and refreshes it after a package update, but only from a package file that is root-owned and not writable by others), then starts it.
- **Boot persistence**: bind mounts do not survive a reboot. The helper starts at boot-up and re-applies every enabled mount from `mounts.conf`.
- **Helper updates**: when a new package version ships a newer helper, the app shows an **Update helper** banner. Entering your password lets the app briefly run the task with `--force`, then restore the normal command.

## Safety checks

The helper is the only part running as root, so it treats everything it receives as untrusted:

- Paths must look like `/volumeN/...`. Parent references (`..`) and DSM system folders (names starting with `@` or `#`, such as `@eaDir` and `#recycle`) are rejected.
- Paths are resolved with `readlink -f` and validated again, so symlinks cannot be used to escape the volume.
- The source and target must be on the same volume, must differ, and cannot be inside one another.
- A target that is a whole top-level shared folder must be empty (ignoring `@` and `#` entries). The helper will not mount over existing data.
- Duplicate targets and already-mounted folders are refused.
- If a mount cannot be cleanly unmounted, a lazy unmount is used as a fallback.
- If the package is removed, the helper notices and releases all of its mounts by itself.

## Updating and uninstalling

**Update:** install the newer `.spk` over the old one with Manual Install. Your mounts list is kept. If the app shows **The helper needs updating**, type your DSM password and click **Update helper**. If DSM refuses to install an older or equal version over a newer one, uninstall first (your mounts are in `mounts.conf`, back it up if you want to restore them automatically).

**Uninstall:**

1. Remove or switch off your mounts in the app first (optional, the helper also releases them when the package is removed).
2. Uninstall the package in Package Center.
3. In Task Scheduler delete the **Bind Mount Manager** task.
4. The empty shared folders it created stay. Delete them in Shared Folder if you no longer need them.
5. Optional: remove the installed copy with `sudo rm /usr/local/bin/bmm-helper`.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| "Setup needed" stays after setup | Task Scheduler > select **Bind Mount Manager** > Run. Then press **Check again**. Look at `/run/bindmountmanager/helper.log`. |
| Automatic setup says DSM refused | Open DSM over `https://`, re-type your password. Use **Manual install** as the fallback. |
| "Could not create the share" | Create an empty shared folder in Control Panel > Shared Folder and use **Use an existing empty folder instead**. |
| Mount is **Waiting** after reboot | The volume was not ready yet. The helper retries every few seconds. |
| New share shows nothing / access denied | Check the share's **Permissions** (see above), then the permissions of the source files. |
| The page looks old after an update | Hard refresh with Ctrl+F5. |
| Install is refused: package from unknown publisher | Package Center > Settings > General > Trust Level > Any publisher. |

The setup log of the install wizard is `/var/packages/BindMountManager/var/setup.log` (it never contains the password). Live status files are in `/run/bindmountmanager/`.

## FAQ

**Is it safe for my data?**
A bind mount is a second view of the same folder, not a copy. Removing the mount or the app does not delete files. The only deletion risk is the usual one: deleting files through the new share deletes them in the source, because they are the same files. Tick **Read only** if in doubt.

**Why only the same volume?**
It keeps the new share next to the data and avoids confusing cross-volume setups. It is a deliberate limit.

**Why does it need a password and a root task?**
Mounting needs root, and DSM 7 does not allow third-party packages to run as root. A Task Scheduler task created by an administrator is the supported way. DSM asks for password confirmation to create it, and so does the app.

**Will it work with Hyper Backup, snapshots and Btrfs?**
The source folder is untouched, so its backups and snapshots behave as before. Hyper Backup of the new share would see the same files again, so back up the source and exclude the bind-mounted share to avoid doing the work twice.

**Does it work over NFS, WebDAV, File Station?**
Anything that reads the shared folder sees the files. SMB is the main use case and the one tested.

**Can I mount into an existing shared folder instead of creating a new one?**
Yes, use **Use an existing empty folder instead**, or a subfolder of a shared folder where the helper allows it.

## Building from source

```
./build.sh
```

This produces `BindMountManager-<version>.spk`. Layout:

```
pkg/bin/     bmm-helper.sh, install-helper.sh   (go into package.tgz)
pkg/ui/      api.cgi, app.js, app.css, app page, config, images  (go into package.tgz)
spk/         INFO, icons, conf/privilege, scripts/, WIZARD_UIFILES/
build.sh     packs package.tgz, updates the checksum in INFO, builds the .spk
```

The version number lives in four places: `spk/INFO`, `APP_VERSION` and `EXPECTED_HELPER` in `pkg/ui/api.cgi`, and `HELPER_VERSION` in `pkg/bin/bmm-helper.sh`. When the UI changes, rename the entry page (for example `app-v100.html`), update the `url` in `pkg/ui/config` and the `?v=` query strings, so browsers do not serve cached files.

## Disclaimer

This software is provided as is, without warranty. It mounts folders as root on your NAS. Read the code, keep backups and test on non-critical data first. Synology and DiskStation Manager are trademarks of Synology Inc.

## Licence

MIT, see [LICENSE](LICENSE).
