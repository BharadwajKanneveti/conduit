fn main() {
    if let Ok(triple) = std::env::var("TARGET") {
        println!("cargo:rustc-env=CONDUIT_TARGET_TRIPLE={triple}");
    }
    #[cfg(feature = "desktop")]
    tauri_build::build()
}
