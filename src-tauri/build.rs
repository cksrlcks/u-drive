/// 앱 커맨드는 창마다 허용한 것만 부를 수 있다(capabilities/*.json의 allow-…).
/// 받기 요청 팝업(nearby-offer)은 답하기에 필요한 몇 개만 쓴다. 새 커맨드를 만들면 여기와 capabilities에 함께 넣는다
const COMMANDS: &[&str] = &[
    "greet",
    "file_icon",
    "quit",
    "device_name",
    "tls_probe",
    "set_prefs",
    "free_path",
    "append_log",
    "open_log_dir",
    "mcp_ready",
    "mcp_respond",
    "read_local_file",
    "recent_files",
    "real_path",
    "write_local_file",
    "list_upload_files",
    "read_local_range",
    "nearby_start",
    "nearby_stop",
    "nearby_peers",
    "nearby_offers",
    "nearby_send",
    "nearby_answer",
    "nearby_cancel",
    "nearby_cleanup",
    "nearby_open_settings",
    "sync_scan",
    "sync_watch",
    "sync_unwatch",
    "sync_state_read",
    "sync_state_write",
    "sync_state_delete",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS))).expect("tauri build");
}
