fn main() {
    // Expose the target triple so the runtime can locate the dev-mode sidecar
    // staged at `binaries/cali-core-<triple>`. Cargo sets TARGET for build
    // scripts but not for the crate itself.
    if let Ok(target) = std::env::var("TARGET") {
        println!("cargo:rustc-env=TARGET={target}");
    }
    tauri_build::build();
}
