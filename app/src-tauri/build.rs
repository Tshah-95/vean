fn main() {
    // Source-tree contract tests compile before packaging has staged external
    // binaries. A real package build stages them first; only the absent-artifact
    // case gets a non-bundling Tauri override.
    if std::env::var_os("TAURI_CONFIG").is_none()
        && !std::path::Path::new("sidecars/bin/melt-aarch64-apple-darwin").exists()
    {
        std::env::set_var(
            "TAURI_CONFIG",
            r#"{"bundle":{"externalBin":[],"resources":[]}}"#,
        );
    }
    tauri_build::build()
}
