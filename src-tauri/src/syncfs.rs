//! 폴더 동기화: PC 폴더 훑기·변경 감시·기준 상태 파일

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, Debouncer};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanFile {
    rel: String,
    path: String,
    size: u64,
    /// 유닉스 초
    mtime: f64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncScan {
    files: Vec<ScanFile>,
    /// 루트를 뺀 모든 하위 폴더(빈 폴더 포함)
    dirs: Vec<String>,
    total_bytes: u64,
    /// 못 읽은 폴더·항목의 상대 경로. 그 아래 파일은 "없어진 것"이 아니라 "모르는 것"이다
    unreadable: Vec<String>,
}

/// 동기화에서 뺄 이름: 점으로 시작(.git·.DS_Store…), 오피스 잠금(~$), 임시(.tmp), 윈도우 메타
fn ignored(name: &str) -> bool {
    let l = name.to_lowercase();
    name.starts_with('.') || name.starts_with("~$") || l.ends_with(".tmp") || l == "thumbs.db" || l == "desktop.ini"
}

/// root 아래를 훑는다. 링크된 폴더는 따라가지 않고, 링크된 파일은 가리키는 파일을 쓴다. 못 읽는 하위 항목은 unreadable에 담는다
fn scan(root: &Path) -> Result<SyncScan, String> {
    fn walk(p: &Path, rel: &str, out: &mut SyncScan) -> bool {
        let Ok(rd) = std::fs::read_dir(p) else {
            out.unreadable.push(rel.to_string());
            return false;
        };
        for e in rd {
            let Ok(e) = e else {
                // 항목 하나를 못 읽으면 어느 것인지 몰라 폴더 전체를 모르는 것으로 둔다
                out.unreadable.push(rel.to_string());
                continue;
            };
            let name = e.file_name().to_string_lossy().into_owned();
            if ignored(&name) {
                continue;
            }
            let path = e.path();
            let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            let Ok(lm) = std::fs::symlink_metadata(&path) else {
                out.unreadable.push(r);
                continue;
            };
            if lm.is_dir() {
                out.dirs.push(r.clone());
                walk(&path, &r, out);
            } else {
                match std::fs::metadata(&path) {
                    Ok(m) if m.is_file() => {
                        let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs_f64()).unwrap_or_default();
                        out.total_bytes += m.len();
                        out.files.push(ScanFile { rel: r, path: path.to_string_lossy().into_owned(), size: m.len(), mtime });
                    }
                    Ok(_) => {}
                    Err(_) => out.unreadable.push(r),
                }
            }
        }
        true
    }
    if !std::fs::metadata(root).is_ok_and(|m| m.is_dir()) {
        return Err("NOT_FOUND".into());
    }
    let mut out = SyncScan { files: vec![], dirs: vec![], total_bytes: 0, unreadable: vec![] };
    if !walk(root, "", &mut out) {
        return Err("NOT_FOUND".into());
    }
    // 루트 항목 오류는 ""로 기록된다: 루트 전체가 모호하므로 못 읽음으로 취급(TS에서 전부 보호)
    Ok(out)
}

/// 기준 상태 파일 경로. id는 영문·숫자·-만(경로 탈출 방지)
fn state_path(base: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("잘못된 동기화 id".into());
    }
    Ok(base.join("sync").join(format!("{id}.json")))
}

fn state_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    state_path(&app.path().app_data_dir().map_err(|e| e.to_string())?, id)
}

/// 동기화 id별 폴더 감시 핸들(놓으면 감시가 멈춘다)
#[derive(Default)]
pub struct Watchers(Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>);

#[tauri::command]
pub async fn sync_scan(root: String) -> Result<SyncScan, String> {
    scan(Path::new(&root))
}

/// 1.5초 디바운스 후 sync-changed(payload: id). 같은 id는 교체. 감시 오류도 같은 이벤트로 알려 다시 훑게 한다
/// async: 큰 폴더의 재귀 감시 등록이 메인 스레드(창)를 막지 않게
#[tauri::command]
pub async fn sync_watch(app: AppHandle, state: State<'_, Watchers>, id: String, root: String) -> Result<(), String> {
    let (emitter, eid) = (app.clone(), id.clone());
    let mut deb = new_debouncer(Duration::from_millis(1500), move |_res| {
        let _ = emitter.emit("sync-changed", &eid);
    })
    .map_err(|e| e.to_string())?;
    deb.watcher().watch(Path::new(&root), RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    state.0.lock().unwrap().insert(id, deb);
    Ok(())
}

#[tauri::command]
pub fn sync_unwatch(state: State<Watchers>, id: String) {
    state.0.lock().unwrap().remove(&id);
}

#[tauri::command]
pub fn sync_state_read(app: AppHandle, id: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(state_file(&app, &id)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn sync_state_write(app: AppHandle, id: String, json: String) -> Result<(), String> {
    let p = state_file(&app, &id)?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    // 쓰다 끊겨도 기존 상태가 남게 임시 파일에 쓰고 바꿔치기
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_state_delete(app: AppHandle, id: String) -> Result<(), String> {
    match std::fs::remove_file(state_file(&app, &id)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("seadrive-syncfs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn ignored_names() {
        for n in ["~$기획안.docx", "a.tmp", "~WRL0001.TMP", "Thumbs.db", "desktop.ini", ".DS_Store", ".git"] {
            assert!(ignored(n), "{n}");
        }
        for n in ["기획안.docx", "tmp", "a.tmpl", "보고서~.docx"] {
            assert!(!ignored(n), "{n}");
        }
    }

    #[test]
    fn scan_lists_files_and_dirs_skipping_ignored() {
        let d = temp_dir("scan");
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::create_dir_all(d.join("빈폴더")).unwrap();
        std::fs::create_dir_all(d.join(".hidden")).unwrap();
        std::fs::write(d.join("a.docx"), "12").unwrap();
        std::fs::write(d.join("sub/b.txt"), "123").unwrap();
        std::fs::write(d.join("~$a.docx"), "x").unwrap();
        std::fs::write(d.join(".hidden/c.txt"), "x").unwrap();
        let s = scan(&d).unwrap();
        let mut files: Vec<_> = s.files.iter().map(|f| f.rel.clone()).collect();
        files.sort();
        let mut dirs = s.dirs.clone();
        dirs.sort();
        assert_eq!(files, ["a.docx", "sub/b.txt"]);
        assert_eq!(dirs, ["sub", "빈폴더"]);
        assert_eq!(s.total_bytes, 5);
    }

    // 이식 가능한 방법이 없어 유닉스에서만: 권한 없는 하위 폴더는 unreadable에 담긴다(root 사용자면 건너뜀)
    #[cfg(unix)]
    #[test]
    fn scan_reports_unreadable_dir() {
        use std::os::unix::fs::PermissionsExt;
        let d = temp_dir("unreadable");
        std::fs::create_dir_all(d.join("locked")).unwrap();
        std::fs::write(d.join("locked/a.docx"), "x").unwrap();
        std::fs::set_permissions(d.join("locked"), std::fs::Permissions::from_mode(0o000)).unwrap();
        let s = scan(&d).unwrap();
        std::fs::set_permissions(d.join("locked"), std::fs::Permissions::from_mode(0o755)).unwrap();
        if std::fs::read_dir(d.join("locked")).is_ok() && s.unreadable.is_empty() {
            return; // root라 권한이 안 먹는다
        }
        assert_eq!(s.unreadable, ["locked"]);
        assert!(s.files.is_empty());
    }

    #[test]
    fn scan_missing_root_is_not_found() {
        let d = temp_dir("missing");
        assert_eq!(scan(&d.join("없음")).unwrap_err(), "NOT_FOUND");
    }

    #[test]
    fn state_id_rejects_traversal() {
        let base = temp_dir("state");
        assert!(state_path(&base, "../x").is_err());
        assert!(state_path(&base, "abc-123").is_ok());
    }
}
