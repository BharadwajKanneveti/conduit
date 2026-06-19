fn main() {
    // Expose the build target triple so the app can locate the gateway sidecar,
    // which Tauri installs next to the main binary with a `-<triple>` suffix.
    if let Ok(triple) = std::env::var("TARGET") {
        println!("cargo:rustc-env=CONDUIT_TARGET_TRIPLE={triple}");
    }
    tauri_build::build()
}
