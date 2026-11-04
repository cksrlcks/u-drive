//! MCP 도구가 쓰는 로컬 파일 접근 (올릴 파일 읽기, 최근 다운로드, 작업 공간 파일 내려받기)

use serde::Serialize;
use std::path::Path;

pub(crate) const READ_CAP: u64 = 200 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    name: String,
    path: String,
    size: u64,
    /// 유닉스 초
    mtime: f64,
}

/// 파일 전체를 읽는다. cap을 넘으면 거절(문구는 실제 상한 200MB 기준)
fn read_capped(path: &Path, cap: u64) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|_| format!("파일을 찾을 수 없습니다: {}", path.display()))?;
    if meta.len() > cap {
        return Err("200MB가 넘는 파일은 U-Drive 앱에서 직접 올려 주세요".into());
    }
    std::fs::read(path).map_err(|e| e.to_string())
}

/// dir 바로 아래 파일만, 수정 시각 최신순으로 limit개
fn list_recent(dir: &Path, limit: usize) -> Result<Vec<LocalFile>, String> {
    let mut files: Vec<LocalFile> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok().filter(|m| m.is_file())?;
            let mtime = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs_f64();
            Some(LocalFile { name: e.file_name().to_string_lossy().into_owned(), path: e.path().to_string_lossy().into_owned(), size: m.len(), mtime })
        })
        .collect();
    files.sort_by(|a, b| b.mtime.total_cmp(&a.mtime));
    files.truncate(limit);
    Ok(files)
}

#[tauri::command]
pub async fn read_local_file(path: String) -> Result<tauri::ipc::Response, String> {
    read_capped(Path::new(&path), READ_CAP).map(tauri::ipc::Response::new)
}

/// 새 파일로만 쓴다. 이미 있으면 거절(사용자 파일을 덮어쓰지 않게)
fn write_new(path: &Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    f.write_all(data).map_err(|e| e.to_string())
}

/// MCP upload_base64: Claude 작업 공간의 파일을 PC 다운로드 폴더에 내려받는다
#[tauri::command]
pub async fn write_local_file(path: String, data: Vec<u8>) -> Result<(), String> {
    write_new(Path::new(&path), &data)
}

/// 심볼릭 링크를 따라간 실제 경로. 아직 없는 파일이면 부모 폴더만 따라가 이름을 붙이고, 그것도 없으면 그대로.
/// MCP가 숨김·시스템 폴더를 막을 때 링크로 돌아가지 못하게 쓴다(localPath.ts)
fn resolve(path: &Path) -> std::path::PathBuf {
    std::fs::canonicalize(path)
        .or_else(|e| match (path.parent(), path.file_name()) {
            (Some(dir), Some(name)) => std::fs::canonicalize(dir).map(|d| d.join(name)),
            _ => Err(e),
        })
        .unwrap_or_else(|_| path.to_path_buf())
}

/// 윈도우 canonicalize의 \\?\ 접두어를 뗀다(\\?\UNC\server → \\server)
fn plain(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        p.strip_prefix(r"\\?\").unwrap_or(p).to_string()
    }
}

#[tauri::command]
pub fn real_path(path: String) -> String {
    plain(&resolve(Path::new(&path)).to_string_lossy())
}

/// 저장할 이름에서 경로 부분을 뗀다(../ 로 다른 폴더에 쓰지 못하게). 남는 게 없으면 "file"
pub(crate) fn plain_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if base.is_empty() || base == "." || base == ".." { "file".into() } else { base.to_string() }
}

#[tauri::command]
pub fn recent_files(dir: String, limit: usize) -> Result<Vec<LocalFile>, String> {
    list_recent(Path::new(&dir), limit)
}

/// 업로드할 로컬 파일. dir = 고른·끌어다 놓은 항목 기준 하위 폴더("" 또는 "사진/2026")
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadFile {
    path: String,
    name: String,
    dir: String,
    size: u64,
    /// 유닉스 초
    mtime: f64,
}

/// 파일·폴더 경로들을 업로드할 파일 목록으로 펼친다. 폴더는 그 폴더 이름부터 하위 경로가 된다.
/// 링크된 폴더는 따라가지 않는다(순환 방지). 링크된 파일은 가리키는 파일을 올린다. 빈 폴더는 만들지 않는다
fn expand_uploads(paths: &[String]) -> Vec<UploadFile> {
    fn walk(p: &Path, dir: &str, out: &mut Vec<UploadFile>) {
        let Ok(lm) = std::fs::symlink_metadata(p) else { return };
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if lm.is_dir() {
            let sub = if dir.is_empty() { name } else { format!("{dir}/{name}") };
            for e in std::fs::read_dir(p).into_iter().flatten().flatten() {
                walk(&e.path(), &sub, out);
            }
        } else if let Some(m) = std::fs::metadata(p).ok().filter(|m| m.is_file()) {
            let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs_f64()).unwrap_or_default();
            out.push(UploadFile { path: p.to_string_lossy().into_owned(), name, dir: dir.to_string(), size: m.len(), mtime });
        }
    }
    let mut out = Vec::new();
    for p in paths {
        walk(Path::new(p), "", &mut out);
    }
    out
}

#[tauri::command]
pub async fn list_upload_files(paths: Vec<String>) -> Vec<UploadFile> {
    expand_uploads(&paths)
}

/// 업로드 조각: path의 start부터 len바이트(파일 끝이면 그보다 짧게)
pub(crate) fn read_range(path: &Path, start: u64, len: u64) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(len.min(READ_CAP) as usize);
    f.take(len.min(READ_CAP)).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

#[tauri::command]
pub async fn read_local_range(path: String, start: u64, len: u64) -> Result<tauri::ipc::Response, String> {
    read_range(Path::new(&path), start, len).map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("seadrive-localfs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn expand_uploads_keeps_folder_structure() {
        let d = temp_dir("expand");
        std::fs::create_dir_all(d.join("사진/2026")).unwrap();
        std::fs::create_dir_all(d.join("사진/빈 폴더")).unwrap();
        std::fs::write(d.join("사진/a.jpg"), "12").unwrap();
        std::fs::write(d.join("사진/2026/b.jpg"), "123").unwrap();
        std::fs::write(d.join("메모.txt"), "1").unwrap();
        let paths = [d.join("사진"), d.join("메모.txt"), d.join("없는 파일")].map(|p| p.to_string_lossy().into_owned());
        let mut got: Vec<_> = expand_uploads(&paths).into_iter().map(|f| (f.dir, f.name, f.size)).collect();
        got.sort();
        assert_eq!(got, [("".into(), "메모.txt".into(), 1), ("사진".into(), "a.jpg".into(), 2), ("사진/2026".into(), "b.jpg".into(), 3)]);
    }

    #[test]
    fn read_range_reads_slice_and_stops_at_end() {
        let p = temp_dir("range").join("x.bin");
        std::fs::write(&p, b"0123456789").unwrap();
        assert_eq!(read_range(&p, 2, 3).unwrap(), b"234");
        assert_eq!(read_range(&p, 8, 5).unwrap(), b"89");
    }

    #[test]
    fn read_capped_reads_korean_path() {
        let p = temp_dir("ko").join("회의 자료.txt");
        std::fs::write(&p, "안녕").unwrap();
        assert_eq!(read_capped(&p, 10).unwrap(), "안녕".as_bytes());
    }

    #[test]
    fn write_new_never_overwrites() {
        let p = temp_dir("write").join("보고서.docx");
        write_new(&p, b"hello").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"hello");
        assert!(write_new(&p, b"other").is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"hello");
    }

    #[test]
    fn read_capped_rejects_over_cap() {
        let p = temp_dir("cap").join("big.bin");
        std::fs::write(&p, [0u8; 11]).unwrap();
        assert!(read_capped(&p, 10).unwrap_err().contains("200MB"));
    }

    #[test]
    fn plain_name_drops_directories() {
        assert_eq!(plain_name("보고서.docx"), "보고서.docx");
        assert_eq!(plain_name("../../Library/LaunchAgents/x.plist"), "x.plist");
        assert_eq!(plain_name(r"..\..\x.bat"), "x.bat");
        assert_eq!(plain_name(".."), "file");
    }

    #[test]
    fn plain_strips_verbatim_prefix() {
        assert_eq!(plain(r"\\?\C:\Users\a"), r"C:\Users\a");
        assert_eq!(plain(r"\\?\UNC\srv\share"), r"\\srv\share");
        assert_eq!(plain("/Users/a"), "/Users/a");
    }

    #[cfg(unix)]
    #[test]
    fn resolve_follows_links() {
        let d = temp_dir("link");
        let secret = d.join(".ssh");
        std::fs::create_dir(&secret).unwrap();
        std::os::unix::fs::symlink(&secret, d.join("work")).unwrap();
        let real = std::fs::canonicalize(&secret).unwrap();
        assert_eq!(resolve(&d.join("work")), real);
        assert_eq!(resolve(&d.join("work").join("new.txt")), real.join("new.txt"));
        assert_eq!(resolve(Path::new("/no/such/dir/x")), Path::new("/no/such/dir/x"));
    }

    #[test]
    fn list_recent_sorts_and_limits() {
        let d = temp_dir("recent");
        for (i, n) in ["old.txt", "mid.txt", "new.txt"].iter().enumerate() {
            let f = std::fs::File::create(d.join(n)).unwrap();
            f.set_modified(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000 + i as u64 * 100)).unwrap();
        }
        std::fs::create_dir(d.join("folder")).unwrap();
        let names: Vec<String> = list_recent(&d, 2).unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(names, ["new.txt", "mid.txt"]);
    }
}
