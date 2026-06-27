#[tauri::command]
fn action_runtime_boundary() -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "surface": "tauri",
        "boundary": "registered-actions"
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![action_runtime_boundary])
        .run(tauri::generate_context!())
        .expect("error while running vean app");
}
