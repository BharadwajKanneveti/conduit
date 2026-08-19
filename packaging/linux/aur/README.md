# Arch Linux (AUR): `toolport-bin`

Arch and Arch-derived distros (Manjaro, EndeavourOS, **Omarchy**) should install
Toolport from the AUR, not from the AppImage.

```bash
# any AUR helper
paru -S toolport-bin
yay -S toolport-bin

# Omarchy
omarchy pkg aur add toolport-bin
```

## Why a native package instead of the AppImage

The AppImage bundles Ubuntu 22.04's `libwebkit2gtk-4.1`, because that is what
`release.yml` builds against. It is old enough to have no `WebKitGPUProcess` at
all, and it cannot initialise EGL against a current Mesa. On Arch that shows up
as a window that opens **grey and empty**: the GTK shell runs while
`WebKitWebProcess` aborts on `EGL_BAD_PARAMETER` on every launch.

This is the bundle, not the machine. On the same failing session, `eglinfo -B -p
wayland|gbm|surfaceless` is healthy and a ten-line python-gobject `WebKit2 4.1`
WebView renders fine through the **system** WebKitGTK. None of
`WEBKIT_DISABLE_DMABUF_RENDERER`, `WEBKIT_DISABLE_COMPOSITING_MODE` or
`WEBKIT_FORCE_SANDBOX=0` avoids it, alone or combined. Displacing only the
bundled WebKit does not fix it either: each round surfaces the next ABI mismatch
as an `undefined symbol` (`gst_debug_log_id`, then `g_once_init_leave_pointer`),
and only displacing every shadowing library at once converges.

A bundled browser engine and a rolling-release GPU stack cannot be kept in
agreement, so this package does not try. It repackages the payload of the
official `.deb` and declares real Arch dependencies, so Toolport links the host's
WebKitGTK, exactly as the `.deb` does on Debian/Ubuntu.

The fat AppImage is unchanged and stays the right download for Ubuntu/Debian.

## PKGBUILD is generated, not checked in

`PKGBUILD` and `.SRCINFO` carry a `sha256sum` of the `.deb` for one specific
release, so a checked-in copy would either be stale or be a checksum nobody
verified. They are rendered per release instead:

```bash
# after the GitHub release is PUBLISHED (draft assets 404)
scripts/render-aur.sh 1.15.0 ./aur
```

`.github/workflows/aur.yml` runs exactly that on `release: released`, builds the
package in an `archlinux:base-devel` container to prove the PKGBUILD works,
replaces the rendered `.SRCINFO` with `makepkg --printsrcinfo` output, and pushes
to the AUR. Package metadata (description, `depends`, `optdepends`) lives in
`scripts/render-aur.sh`; edit it there.

## One-time setup before the first publish

The workflow no-ops with a warning until this is done, so it can never fail a
release.

1. Create an AUR account at <https://aur.archlinux.org/> and add an SSH public
   key to it.
2. Put the matching **private** key in the repo secret `AUR_SSH_PRIVATE_KEY`.
3. Confirm the pinned `aur.archlinux.org` host key in `aur.yml` still matches the
   "SSH Fingerprints" published on <https://aur.archlinux.org/>. A mismatch fails
   the push closed rather than trusting a new key.
4. Set the `# Maintainer:` line in `scripts/render-aur.sh` to the AUR account's
   name and email if you want the conventional format.
5. Run the workflow once manually (`workflow_dispatch`) with the release tag and
   `dry_run` **checked**, to build and validate without pushing. Then re-run with
   `dry_run` unchecked; the first push creates the `toolport-bin` package.

## Verifying a release by hand

```bash
scripts/render-aur.sh 1.15.0 ./aur
cd aur && makepkg -si
pgrep -x Xwayland   # still returns a PID after launching and quitting Toolport
```
