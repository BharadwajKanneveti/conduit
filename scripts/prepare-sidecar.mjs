// Build the conduit-gateway binary and stage it where Tauri's `externalBin`
// bundler expects it: `src-tauri/binaries/conduit-gateway-<target-triple><ext>`.
// Runs as part of `beforeBuildCommand`, so a packaged app always ships a gateway
// matching the host target. Pass `--debug` to stage a debug build instead.
import { execSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";

function hostTriple() {
  const out = execSync("rustc -vV", { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.startsWith("host:"));
  if (!line) throw new Error("could not determine host target triple from `rustc -vV`");
  return line.split(":")[1].trim();
}

const debug = process.argv.includes("--debug");
const profile = debug ? "debug" : "release";
const triple = hostTriple();
const ext = process.platform === "win32" ? ".exe" : "";

const destDir = join("src-tauri", "binaries");
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, `conduit-gateway-${triple}${ext}`);

// Break the chicken-and-egg: when the bundle config is active, the gateway's own
// build (via the shared build.rs -> tauri_build) validates that this externalBin
// path already exists. Seed a placeholder so that compile-time check passes; we
// overwrite it with the real binary immediately after.
if (!existsSync(dest)) {
  writeFileSync(dest, "");
}

console.log(`[sidecar] building conduit-gateway (${profile}) for ${triple}`);
try {
  execSync(`cargo build ${debug ? "" : "--release"} --bin conduit-gateway`, {
    cwd: "src-tauri",
    stdio: "inherit",
  });
} catch (e) {
  // Don't leave the empty placeholder behind - it would ship as a 0-byte,
  // non-executable "gateway".
  rmSync(dest, { force: true });
  throw e;
}

const src = join("src-tauri", "target", profile, `conduit-gateway${ext}`);
if (!existsSync(src)) {
  rmSync(dest, { force: true });
  throw new Error(`built gateway not found at ${src}`);
}

copyFileSync(src, dest);
// On macOS/Linux the bundled sidecar must be executable.
if (process.platform !== "win32") {
  chmodSync(dest, 0o755);
}
console.log(`[sidecar] staged -> ${dest}`);
