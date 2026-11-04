//! 디자인나스: 고른 하드 폴더(루트) 안만 읽는다. 쓰기·삭제·이동 없음, 루트 밖으로 나가는 경로는 거절

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NasEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub size: u64,
    /// 유닉스 초
    pub mtime: f64,
    /// 루트 기준 "/a/b.psd"
    pub path: String,
}

const DENIED: &str = "허용되지 않는 경로입니다";

/// 목록·색인에서 뺄 이름(대소문자 무시)
fn excluded(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with('.') || n.starts_with("~$") || ["$recycle.bin", "system volume information", "thumbs.db", "desktop.ini"].contains(&n.as_str())
}

/// 루트 기준 경로("/a/b")를 실제 경로로. `..`·절대 경로·링크/정션 탈출은 거절
pub fn resolve_in(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if !rel.starts_with('/') || rel.contains('\\') || rel.split('/').any(|s| s == "..") {
        return Err(DENIED.into());
    }
    let root = std::fs::canonicalize(root).map_err(|_| DENIED.to_string())?;
    let target = std::fs::canonicalize(root.join(rel.trim_start_matches('/'))).map_err(|_| DENIED.to_string())?;
    if target.starts_with(&root) { Ok(target) } else { Err(DENIED.into()) }
}

fn entry(name: String, path: String, m: &std::fs::Metadata) -> NasEntry {
    let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs_f64()).unwrap_or_default();
    NasEntry { name, kind: if m.is_dir() { "dir" } else { "file" }.into(), size: if m.is_dir() { 0 } else { m.len() }, mtime, path }
}

/// rel 폴더의 바로 아래 항목. 폴더 먼저, 이름순
pub fn list(root: &Path, rel: &str) -> Result<Vec<NasEntry>, String> {
    let dir = resolve_in(root, rel)?;
    let base = rel.trim_end_matches('/');
    let mut out: Vec<NasEntry> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if excluded(&name) {
                return None;
            }
            let m = e.metadata().ok()?;
            Some(entry(name.clone(), format!("{base}/{name}"), &m))
        })
        .collect();
    out.sort_by_key(|a| (a.kind != "dir", a.name.to_lowercase()));
    Ok(out)
}

/// 루트 아래 전부(재귀). 링크된 폴더는 따라가지 않고, 제외된 폴더는 통째로 건너뛴다. 1000개마다 progress
pub fn build_index(root: &Path, mut progress: impl FnMut(usize)) -> Vec<NasEntry> {
    fn walk(dir: &Path, base: &str, out: &mut Vec<NasEntry>, progress: &mut impl FnMut(usize)) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if excluded(&name) {
                continue;
            }
            let (Ok(ft), Ok(m)) = (e.file_type(), e.metadata()) else { continue };
            let path = format!("{base}/{name}");
            out.push(entry(name, path.clone(), &m));
            if out.len().is_multiple_of(1000) {
                progress(out.len());
            }
            if ft.is_dir() {
                walk(&e.path(), &path, out, progress);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, "", &mut out, &mut progress);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("seadrive-nasfs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn resolve_in_rejects_escape() {
        let root = temp_dir("nas-root");
        std::fs::create_dir_all(root.join("a")).unwrap();
        assert!(resolve_in(&root, "/a").is_ok());
        for bad in ["/../x", "/a/../../x", "a", r"C:\Windows", r"/a\..\..\x"] {
            assert!(resolve_in(&root, bad).is_err(), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolve_in_rejects_link_out_of_root() {
        let root = temp_dir("nas-link-root");
        let outside = temp_dir("nas-link-out");
        std::os::unix::fs::symlink(&outside, root.join("out")).unwrap();
        assert!(resolve_in(&root, "/out").is_err());
    }

    #[test]
    fn list_sorts_dirs_first_and_skips_excluded() {
        let root = temp_dir("nas-list");
        for d in ["사진", "$RECYCLE.BIN"] {
            std::fs::create_dir(root.join(d)).unwrap();
        }
        for f in ["b.psd", "a.ai", ".DS_Store", "~$x.docx", "Thumbs.db"] {
            std::fs::write(root.join(f), "x").unwrap();
        }
        let got = list(&root, "/").unwrap();
        let kn: Vec<_> = got.iter().map(|e| (e.kind.as_str(), e.name.as_str())).collect();
        assert_eq!(kn, [("dir", "사진"), ("file", "a.ai"), ("file", "b.psd")]);
        assert_eq!(got[0].path, "/사진");
        assert_eq!(got[2].path, "/b.psd");
    }

    #[test]
    fn build_index_walks_tree_and_skips_excluded_dirs() {
        let root = temp_dir("nas-index");
        std::fs::create_dir_all(root.join("사진/2020")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("사진/2020/x.jpg"), "x").unwrap();
        std::fs::write(root.join(".git/y"), "x").unwrap();
        std::fs::write(root.join("z.txt"), "x").unwrap();
        let got: std::collections::BTreeSet<_> = build_index(&root, |_| {}).into_iter().map(|e| e.path).collect();
        let want: std::collections::BTreeSet<_> = ["/사진", "/사진/2020", "/사진/2020/x.jpg", "/z.txt"].map(String::from).into();
        assert_eq!(got, want);
    }
}
