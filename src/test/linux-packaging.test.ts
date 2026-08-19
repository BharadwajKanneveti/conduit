// Pins the two Linux packaging fixes for modern Wayland / rolling distros.
//
// 1. The AppImage's `GDK_BACKEND=x11` must be a DEFAULT, not an OVERRIDE.
//    linuxdeploy-plugin-gtk writes it into a hook AppRun sources AFTER the
//    caller's environment, so `GDK_BACKEND=wayland` is silently ignored. On a
//    Wayland session whose Xwayland cannot survive the app that is fatal: the
//    first launch kills Xwayland session-wide and every launch after it blocks
//    forever on the orphaned X socket with no window and no error.
// 2. Arch gets a native package (`toolport-bin`) instead of the fat AppImage,
//    whose bundled Ubuntu 22.04 WebKitGTK cannot initialise EGL against a
//    current Mesa.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

interface Step {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  if?: string;
  env?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on?: unknown;
  jobs?: Record<string, Job>;
}

function read(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}
function workflow(name: string): Workflow {
  return parse(read(".github", "workflows", name)) as Workflow;
}

const PATCH_SCRIPT = "scripts/patch-appimage-gdk-backend.sh";
const patchScript = read(...PATCH_SCRIPT.split("/"));

// The exact line linuxdeploy-plugin-gtk writes, trailing comment and all.
const LINUXDEPLOY_LINE =
  "export GDK_BACKEND=x11 # Crash with Wayland backend on Wayland - We tested it" +
  " without it and ended up with this: https://github.com/tauri-apps/tauri/issues/8541";

// Run the script's ACTUAL sed line rather than a JS transliteration of it: the
// pattern is a POSIX BRE and the first version of it looked right in JS while
// being wrong in sed. Skipped where GNU sed is unavailable (BSD sed on a mac dev
// box); CI runs the frontend tests on ubuntu-22.04, which always has it.
const SED_LINE = patchScript.match(/^sed -i .*"\$hook"$/m)?.[0];

function hasGnuSed(): boolean {
  try {
    return execFileSync("bash", ["-c", "sed --version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).includes("GNU sed");
  } catch {
    return false;
  }
}
const gnuSed = hasGnuSed();

function applyScriptSed(input: string): string {
  const dir = mkdtempSync(join(tmpdir(), "toolport-gdk-"));
  const file = join(dir, "hook.sh");
  try {
    writeFileSync(file, input + "\n");
    execFileSync("bash", ["-c", `hook=${JSON.stringify(file)}; ${SED_LINE}`], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return readFileSync(file, "utf8").replace(/\n$/, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("AppImage GDK_BACKEND is a default, not an override", () => {
  it("has a substitution line to test", () => {
    expect(SED_LINE, `no 'sed -i' line found in ${PATCH_SCRIPT}`).toBeDefined();
  });

  it.skipIf(!gnuSed)(
    "rewrites linuxdeploy's line to an overridable assignment, comment intact",
    () => {
      const out = applyScriptSed(LINUXDEPLOY_LINE);
      expect(out).toContain('export GDK_BACKEND="${GDK_BACKEND:-x11}"');
      // The trailing comment carries the reason linuxdeploy forced it; keep it.
      expect(out).toContain("tauri-apps/tauri/issues/8541");
      // Nothing may still assign x11 unconditionally.
      expect(out).not.toMatch(/^export GDK_BACKEND=x11(\s|$)/m);
    },
  );

  it.skipIf(!gnuSed)("leaves an unrelated GDK_BACKEND assignment alone", () => {
    expect(applyScriptSed("export GDK_BACKEND=wayland")).toBe(
      "export GDK_BACKEND=wayland",
    );
    // Not anchored to a substring of a longer value.
    expect(applyScriptSed("export GDK_BACKEND=x11,wayland")).toBe(
      "export GDK_BACKEND=x11,wayland",
    );
  });

  it("fails loudly when linuxdeploy stops writing the line it expects", () => {
    // A silent no-op here would ship an AppImage that looks patched and is not.
    expect(patchScript).toMatch(/if ! grep -qF "\$old_line" "\$hook"; then/);
    expect(patchScript).toMatch(/exit 1/);
  });

  it("verifies the repack before overwriting the release artifact", () => {
    expect(patchScript).toContain("--appimage-extract");
    // The repacked image is re-extracted and re-checked, and the file count is
    // compared, so a repack that quietly dropped files cannot ship.
    expect(patchScript).toContain("does not contain the patched hook");
    expect(patchScript).toContain("the repack changed the file count");
    // The original runtime is reused rather than a downloaded appimagetool's.
    expect(patchScript).toContain("--appimage-offset");
  });
});

describe("release.yml runs the AppImage patch and re-signs", () => {
  const build = workflow("release.yml").jobs?.build;
  const step = (build?.steps ?? []).find((s) => s.run?.includes(PATCH_SCRIPT));

  it("has the patch step, gated to the Linux matrix leg", () => {
    expect(step, "no release.yml step runs " + PATCH_SCRIPT).toBeDefined();
    expect(step!.if).toBe("matrix.os == 'ubuntu-22.04'");
  });

  it("re-signs, because the patch invalidates the updater signature", () => {
    // Rewriting the AppImage changes the bytes `tauri build` signed. Shipping the
    // stale .sig would break auto-update for every Linux user.
    expect(step!.run).toContain("tauri signer sign");
    expect(step!.env?.TAURI_SIGNING_PRIVATE_KEY).toContain(
      "secrets.TAURI_SIGNING_PRIVATE_KEY",
    );
    expect(step!.env?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toContain(
      "secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    );
  });

  it("installs squashfs-tools, which the repack needs", () => {
    const deps = (build?.steps ?? []).find(
      (s) => s.name === "Install Linux build dependencies",
    );
    expect(deps?.run).toContain("squashfs-tools");
  });
});

// Published at https://aur.archlinux.org/ under "SSH Fingerprints". Duplicated
// here on purpose: the workflow's copy is what runs, and this is the second
// witness that catches an edit to it.
const AUR_ED25519_FINGERPRINT = "SHA256:RFzBCUItH9LZS0cKB5UE6ceAYhBD5C8GeOBip8Z11+4";

describe("the AUR package ships to Arch", () => {
  const aur = workflow("aur.yml");
  const publish = aur.jobs?.publish;
  const steps = publish?.steps ?? [];

  it("waits for the release to be published, like winget does", () => {
    // Draft assets 404, so checksums computed against them would be wrong.
    const on = aur.on as { release?: { types?: string[] } };
    expect(on.release?.types).toEqual(["released"]);
  });

  it("skips prereleases", () => {
    // An Arch pkgver cannot carry `-rc.1`, and a prerelease is not what
    // `pacman -S` should hand people.
    expect(publish?.if).toContain("!github.event.release.prerelease");
  });

  it("build-tests the package before pushing", () => {
    const build = steps.find((s) => s.run?.includes("archlinux:base-devel"));
    expect(build, "no Arch container build step").toBeDefined();
    expect(build!.run).toContain("makepkg");
    expect(build!.run).toContain("usr/bin/toolport");
  });

  it("gates the AUR push on the secret and keeps the key step-scoped", () => {
    const push = steps.find((s) => s.run?.includes("aur.archlinux.org"));
    expect(push, "no AUR push step").toBeDefined();
    expect(push!.if).toContain("env.AUR_KEY_CONFIGURED == 'true'");
    expect(publish?.env?.AUR_KEY_CONFIGURED).toBe(
      "${{ secrets.AUR_SSH_PRIVATE_KEY != '' }}",
    );
    // The push key must not be visible to the container step above it.
    expect(push!.env?.AUR_SSH_PRIVATE_KEY).toContain("secrets.AUR_SSH_PRIVATE_KEY");
    for (const s of steps) {
      if (s !== push) expect(s.env?.AUR_SSH_PRIVATE_KEY, s.name).toBeUndefined();
    }
    // The fetched host key is checked against the fingerprint AUR publishes, so
    // this is not trust-on-first-use. A keyscan with no comparison would be.
    expect(push!.run).toContain(AUR_ED25519_FINGERPRINT);
    expect(push!.run).toMatch(/ssh-keygen -lf/);
    expect(push!.run).toMatch(/if \[ "\$got" != "\$AUR_ED25519_FINGERPRINT" \]/);
  });

  it("does not track a generated PKGBUILD, which pins one release's checksum", () => {
    const ignored = read(".gitignore");
    expect(ignored).toContain("/packaging/linux/aur/PKGBUILD");
    expect(ignored).toContain("/packaging/linux/aur/.SRCINFO");
  });

  it("points Arch users at the AUR from the install script", () => {
    const installer = read("scripts", "install.sh");
    expect(installer).toContain("command -v pacman");
    expect(installer).toContain("toolport-bin");
  });
});
