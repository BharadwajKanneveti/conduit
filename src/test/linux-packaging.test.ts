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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The workflow assertions below run real shell out of aur.yml. Needs bash and
// ssh-keygen; CI runs the frontend tests on ubuntu-22.04, which has both.
function hasBashTools(): boolean {
  try {
    execFileSync("bash", ["-c", "command -v ssh-keygen && command -v sort"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
const bashTools = hasBashTools();

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

  it("refuses to repack an image whose xattrs it cannot carry over", () => {
    // --appimage-extract does not restore xattrs, and the file-count check
    // cannot see a dropped capability bit, so the source is checked instead.
    expect(patchScript).toMatch(/xattrs are \(present\|stored\)/);
    expect(patchScript).toContain("cannot restore");
    // And no -no-xattrs, which would throw away anything that did survive.
    expect(patchScript).not.toContain("-no-xattrs");
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
  // By name, not by matching a URL substring in the script body: a substring
  // test against a URL is exactly the shape CodeQL flags, and the step name is
  // the stabler handle anyway.
  const byName = (name: string) => steps.find((s) => s.name === name);

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
    const build = byName("Build and validate the package in an Arch container");
    expect(build, "no Arch container build step").toBeDefined();
    expect(build!.run).toContain("makepkg");
    expect(build!.run).toContain("usr/bin/toolport");
  });

  it("cannot let the build container alter what gets published", () => {
    // `archlinux:base-devel` is a moving tag. The control is not pinning it, it
    // is that the container gets the PKGBUILD read-only and its .SRCINFO lands
    // in a scratch mount that is only diffed, never published.
    const build = byName("Build and validate the package in an Arch container");
    expect(build!.run).toContain('-v "$PWD/aur:/pkg:ro"');
    expect(build!.run).toContain("--printsrcinfo > /out/.SRCINFO");
    expect(build!.run).toMatch(/diff -u .*srcinfo-out\/\.SRCINFO/);
    // A mismatch must fail the release, not be quietly adopted.
    expect(build!.run).toContain("exit 1");
    expect(build!.env?.AUR_SSH_PRIVATE_KEY).toBeUndefined();
  });

  it.skipIf(!bashTools)("reads one key as one key when the host is dual-stack", () => {
    // ssh-keyscan walks every getaddrinfo result, so an A and an AAAA record for
    // the same host write the SAME key twice. Without the unique step the
    // comparison sees two concatenated fingerprints and fails closed forever.
    const push = byName("Publish to the AUR")!;
    const got = push.run!.match(/^got=\$\(.*$/m)?.[0];
    const uniq = push.run!.match(/^unique=.*$/m)?.[0];
    expect(got, "no host-key fingerprint line").toBeDefined();
    expect(uniq, "no unique-count line").toBeDefined();

    const dir = mkdtempSync(join(tmpdir(), "toolport-hostkey-"));
    try {
      const key = join(dir, "k");
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
      // A known_hosts line is "<host> <type> <base64>", i.e. the .pub without
      // its trailing comment.
      const pub = readFileSync(`${key}.pub`, "utf8").trim().split(/\s+/);
      const line = `aur.archlinux.org ${pub[0]} ${pub[1]}\n`;
      const kh = join(dir, "known_hosts");
      writeFileSync(kh, line + line); // the dual-stack case: same key, twice

      const script = `${got!.replace("~/.ssh/known_hosts", JSON.stringify(kh))}\n${uniq}\nprintf '%s|%s' "$unique" "$got"`;
      const out = execFileSync("bash", ["-c", script], { encoding: "utf8" });
      const [unique, fingerprint] = out.split("|");
      expect(unique, `two copies of one key read as ${unique} keys`).toBe("1");
      expect(fingerprint).toMatch(/^SHA256:/);
      expect(fingerprint).not.toContain("\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!bashTools)("refuses to publish an older version over a newer one", () => {
    // The concurrency group serialises pushes but does not order them by
    // version, so a workflow_dispatch catch-up for an old tag could overwrite a
    // newer AUR package and start handing out the older release.
    const push = byName("Publish to the AUR")!;
    const start = push.run!.indexOf('new_full="${TAG#v}-${AUR_PKGREL}"');
    const end = push.run!.indexOf("cp aur/PKGBUILD");
    expect(start, "no downgrade guard").toBeGreaterThan(-1);
    const guard = push.run!.slice(start, end);

    // onAur / pushing are "<pkgver>-<pkgrel>", the pair pacman actually orders by.
    const run = (onAur: string, pushing: string) => {
      const dir = mkdtempSync(join(tmpdir(), "toolport-aurver-"));
      const [haveVer, haveRel] = onAur.split("-");
      const [wantVer, wantRel] = pushing.split("-");
      try {
        mkdirSync(join(dir, "aur-repo"));
        writeFileSync(
          join(dir, "aur-repo", "PKGBUILD"),
          `pkgver=${haveVer}\npkgrel=${haveRel}\n`,
        );
        return execFileSync(
          "bash",
          [
            "-c",
            `cd ${JSON.stringify(dir)}\nTAG=v${wantVer}\nAUR_PKGREL=${wantRel}\n${guard}\necho PROCEEDED`,
          ],
          { encoding: "utf8" },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    expect(run("1.16.0-1", "1.15.0-1")).toContain("Not downgrading");
    expect(run("1.16.0-1", "1.15.0-1")).not.toContain("PROCEEDED");
    // pkgrel is the other half of the ordering. Re-dispatching the same tag
    // defaults pkgrel back to 1, so a pkgver-only guard would push 1.15.0-1
    // over a 1.15.0-2 that fixed the PKGBUILD, and nobody on -2 would upgrade.
    expect(run("1.15.0-2", "1.15.0-1")).toContain("Not downgrading");
    expect(run("1.15.0-2", "1.15.0-1")).not.toContain("PROCEEDED");
    expect(run("1.15.0-1", "1.15.0-2")).toContain("PROCEEDED");
    expect(run("1.14.0-1", "1.15.0-1")).toContain("PROCEEDED");
    expect(run("1.15.0-1", "1.15.0-1")).toContain("PROCEEDED"); // identical, porcelain skips
    // Not lexical: 1.9.0 must not read as newer than 1.10.0.
    expect(run("1.9.0-1", "1.10.0-1")).toContain("PROCEEDED");
  });

  it("can bump pkgrel so a same-version PKGBUILD fix actually upgrades", () => {
    // pacman compares pkgver-pkgrel; re-publishing a fixed PKGBUILD at the same
    // pkgrel reads as "already installed" everywhere it matters.
    const raw = read(".github", "workflows", "aur.yml");
    expect(raw).toContain("pkgrel:");
    expect(publish?.env?.AUR_PKGREL).toBe("${{ inputs.pkgrel || '1' }}");
    const renderer = read("scripts", "render-aur.sh");
    expect(renderer).toContain("pkgrel=${AUR_PKGREL:-1}");
    expect(renderer).toContain("AUR_PKGREL must be a positive integer");
  });

  it("gates the AUR push on the secret and keeps the key step-scoped", () => {
    const push = byName("Publish to the AUR");
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
    expect(push!.run).toMatch(/\[ "\$got" != "\$AUR_ED25519_FINGERPRINT" \]/);
  });

  it("does not track a generated PKGBUILD, which pins one release's checksum", () => {
    const ignored = read(".gitignore");
    expect(ignored).toContain("/packaging/linux/aur/PKGBUILD");
    expect(ignored).toContain("/packaging/linux/aur/.SRCINFO");
  });

  it("serialises pushes so two releases cannot race a non-fast-forward", () => {
    const raw = read(".github", "workflows", "aur.yml");
    expect(raw).toContain("group: aur-publish");
    expect(raw).toContain("cancel-in-progress: false");
  });

  it("does a full sync before installing into the rolling Arch image", () => {
    // `pacman -Sy` is a partial upgrade: it can pull a namcap whose deps are
    // newer than the image, or leave archlinux-keyring too old to verify.
    const build = byName("Build and validate the package in an Arch container");
    expect(build!.run).toContain("pacman -Syu");
    expect(build!.run).not.toMatch(/pacman -Sy\s/);
  });

  it("normalises a dispatch tag typed without the leading v", () => {
    const norm = byName("Normalise the tag");
    expect(norm, "no tag normalisation step").toBeDefined();
    expect(norm!.run).toContain("v${TAG#v}");
  });
});

describe("install.sh routes Arch users without hanging or eating itself", () => {
  const installer = read("scripts", "install.sh");

  it("detects pacman and names the AUR package", () => {
    expect(installer).toContain("command -v pacman");
    expect(installer).toContain("toolport-bin");
  });

  it("gives each helper flags that actually skip its review prompt", () => {
    // pacman's --noconfirm does NOT cover an AUR helper's own PKGBUILD review.
    expect(installer).toContain("--skipreview");
    expect(installer).toContain("--answerdiff None");
    expect(installer).toContain("--answerclean None");
  });

  it("never lets a helper read the piped installer from stdin", () => {
    // Documented entry point is `curl ... | bash`, so stdin IS this script. A
    // helper that prompts would swallow the rest of it.
    expect(installer).toMatch(/"\$helper" "\$\{helper_args\[@\]\}" <\/dev\/null/);
  });

  it("tries every installed helper before giving up on the AUR", () => {
    // A `break` after the first failure would skip a helper that would work.
    const arch = installer.slice(installer.indexOf("for helper in"));
    const loop = arch.slice(0, arch.indexOf("\n    done"));
    expect(loop).toContain("could not install toolport-bin");
    expect(loop).not.toMatch(/^\s*break\s*$/m);
  });

  it("tries Omarchy's wrapper, which the docs tell those users to run", () => {
    expect(installer).toContain("omarchy) helper_args=(pkg aur add toolport-bin)");
  });

  it("tries pamac, which is all a stock Manjaro has", () => {
    // The README names Manjaro. A default Manjaro ships pamac and usually none
    // of paru/yay, so without this the named distro skips every branch and
    // lands on the AppImage this whole change exists to avoid there.
    expect(installer).toContain("pamac) helper_args=(build --no-confirm toolport-bin)");
    expect(installer).toMatch(/^ *for helper in [a-z ]*\bpamac\b/m);
  });

  it("cannot reach a real AUR helper from the bash installer tests", () => {
    // These tests only shimmed curl and uname, so on an Arch or Manjaro box the
    // Arch branch found the REAL pacman and paru and sudo-installed from the
    // actual AUR mid-test. Ubuntu CI never runs this file, so that only ever
    // fired on a maintainer's own machine.
    const harness = read("scripts", "install.Tests.bash");
    expect(harness).toContain('cat > "$shim_dir/pacman"');
    expect(harness).toMatch(/for helper in paru yay pamac pikaur trizen omarchy/);
    expect(harness).toContain("helper-stdin.log");
  });
});
