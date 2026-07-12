use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, Deserialize)]
pub struct RuntimeLayout {
    pub schema_version: String,
    pub mode: String,
    pub package_root: PathBuf,
    pub project_root: PathBuf,
    pub development_checkout_root: Option<PathBuf>,
    pub manifest_relative_path: String,
    pub resources: Vec<RuntimeResource>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RuntimeResource {
    pub id: String,
    pub relative_path: PathBuf,
    pub sha256: String,
    pub mode: u32,
    pub executable: bool,
}

pub fn compiled_runtime_mode() -> &'static str {
    if cfg!(feature = "package-runtime") {
        "package"
    } else {
        "development"
    }
}

pub fn load(path: &Path) -> Result<RuntimeLayout, String> {
    let bytes = fs::read(path).map_err(|error| format!("E_RUNTIME_LAYOUT_INVALID: {error}"))?;
    let layout: RuntimeLayout = serde_json::from_slice(&bytes)
        .map_err(|error| format!("E_RUNTIME_LAYOUT_INVALID: {error}"))?;
    if layout.schema_version != "vean.runtime-layout/1" {
        return Err("E_RUNTIME_LAYOUT_INVALID: unsupported schema".into());
    }
    if layout.mode != compiled_runtime_mode() {
        return Err(format!(
            "E_RUNTIME_MODE_MISMATCH: compiled {} received {}",
            compiled_runtime_mode(),
            layout.mode
        ));
    }
    if layout.mode == "package" && layout.development_checkout_root.is_some() {
        return Err("E_RUNTIME_LAYOUT_INVALID: package mode named a checkout".into());
    }
    if layout.manifest_relative_path != "runtime-manifest.json" {
        return Err("E_RUNTIME_LAYOUT_INVALID: manifest path".into());
    }
    if !layout.project_root.is_absolute() || !layout.package_root.is_absolute() {
        return Err("E_RUNTIME_LAYOUT_INVALID: roots must be absolute".into());
    }
    Ok(layout)
}

pub fn resource_path(layout: &RuntimeLayout, id: &str) -> Result<PathBuf, String> {
    let resource = layout
        .resources
        .iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| format!("E_RUNTIME_RESOURCE_MISSING: {id}"))?;
    if resource.relative_path.is_absolute()
        || resource
            .relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "E_RUNTIME_PATH_ESCAPE: {}",
            resource.relative_path.display()
        ));
    }
    let root = fs::canonicalize(&layout.package_root)
        .map_err(|error| format!("E_RUNTIME_PATH_DANGLING: {error}"))?;
    let candidate = root.join(&resource.relative_path);
    let metadata = fs::symlink_metadata(&candidate)
        .map_err(|error| format!("E_RUNTIME_PATH_DANGLING: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "E_RUNTIME_PATH_SYMLINK: {}",
            resource.relative_path.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!(
            "E_RUNTIME_PATH_TYPE: {}",
            resource.relative_path.display()
        ));
    }
    if metadata.nlink() != 1 {
        return Err(format!(
            "E_RUNTIME_PATH_HARDLINK: {}",
            resource.relative_path.display()
        ));
    }
    if metadata.mode() & 0o777 != resource.mode {
        return Err(format!(
            "E_RUNTIME_PATH_MODE: {}",
            resource.relative_path.display()
        ));
    }
    if resource.executable && metadata.mode() & 0o111 == 0 {
        return Err(format!(
            "E_RUNTIME_PATH_MODE: {}",
            resource.relative_path.display()
        ));
    }
    let canonical = fs::canonicalize(&candidate)
        .map_err(|error| format!("E_RUNTIME_PATH_DANGLING: {error}"))?;
    if !canonical.starts_with(&root) {
        return Err(format!(
            "E_RUNTIME_PATH_ESCAPE: {}",
            resource.relative_path.display()
        ));
    }
    let bytes =
        fs::read(&canonical).map_err(|error| format!("E_RUNTIME_PATH_IDENTITY: {error}"))?;
    let observed = format!("{:x}", Sha256::digest(bytes));
    if observed != resource.sha256 {
        return Err(format!(
            "E_RUNTIME_HASH_MISMATCH: {}",
            resource.relative_path.display()
        ));
    }
    Ok(canonical)
}

pub fn preflight(layout: &RuntimeLayout) -> Result<(), String> {
    for resource in &layout.resources {
        resource_path(layout, &resource.id)?;
    }
    Ok(())
}

#[cfg(test)]
mod runtime_layout_tests {
    use super::*;

    #[test]
    fn compiled_mode_is_fixed_by_feature() {
        #[cfg(feature = "package-runtime")]
        assert_eq!(compiled_runtime_mode(), "package");
        #[cfg(not(feature = "package-runtime"))]
        assert_eq!(compiled_runtime_mode(), "development");
    }

    #[test]
    fn rejects_traversal_before_filesystem_access() {
        let layout = RuntimeLayout {
            schema_version: "vean.runtime-layout/1".into(),
            mode: compiled_runtime_mode().into(),
            package_root: PathBuf::from("/tmp"),
            project_root: PathBuf::from("/tmp/project"),
            development_checkout_root: None,
            manifest_relative_path: "runtime-manifest.json".into(),
            resources: vec![RuntimeResource {
                id: "core".into(),
                relative_path: PathBuf::from("../escape"),
                sha256: "0".repeat(64),
                mode: 0o755,
                executable: true,
            }],
        };
        assert!(resource_path(&layout, "core")
            .unwrap_err()
            .starts_with("E_RUNTIME_PATH_ESCAPE"));
    }
}
