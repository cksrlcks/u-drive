//! 디자인나스. 서버 PC의 Drive 앱이 고른 하드 폴더(루트)를 같은 사무실 네트워크의 Drive 앱에 읽기 전용으로 연다.
//! 찾기는 mDNS(_udrive-nas._tcp: v·fp·name·server), 연결은 TLS 1.3(tls.rs, 받는 쪽이 mDNS로 알린 지문을 확인).
//!
//! 요청 한 번 = 연결 하나
//!   받는 쪽 → 요청 한 줄(JSON Req)
//!   제공 쪽 → 응답 한 줄. 실패는 {"ok":false,"error":..}
//!     info       → {"ok":true,"name":..,"version":<색인 만든 시각 ms>}
//!     list·index → {"ok":true,"entries":[NasEntry..]}
//!     read       → {"ok":true,"size":<전체 크기>} 다음 줄부터 start~끝 원본 바이트
//!
//! 토큰은 제공 쪽 화면이 같은 Seafile 서버의 getAccount()로 확인한다(nas-verify → nas_verify_reply).
//! 통과한 토큰은 SHA-256만 10분 기억한다. 토큰 원문은 남기지 않는다

use crate::nasfs::{self, NasEntry};
use crate::nearby::read_json;
use crate::tls;
use mdns_sd::{ServiceDaemon, ServiceInfo};
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, Debouncer};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::{mpsc, Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const SERVICE: &str = "_udrive-nas._tcp.local.";
/// 요청의 v, mDNS TXT의 v
const VERSION: u32 = 1;
/// 상대가 이만큼 아무것도 보내지 않으면 끊는다
const IO_TIMEOUT: Duration = Duration::from_secs(30);
/// 동시에 처리하는 연결 수. 넘으면 바로 끊는다(연결마다 스레드 하나)
const MAX_CONNS: usize = 16;
/// 화면이 토큰 확인에 답하기를 기다리는 시간. 지나면 거절
const VERIFY_TIMEOUT: Duration = Duration::from_secs(10);
const VERIFY_TTL: Duration = Duration::from_secs(10 * 60);
/// 마지막 변경 뒤 이만큼 조용하면 색인을 다시 만든다
const REINDEX_DEBOUNCE: Duration = Duration::from_secs(60);
/// 감시가 놓친 변경을 위해 하루 한 번 다시 만든다
const REINDEX_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const REFUSED: &str = "로그인 확인에 실패했습니다";

#[derive(Serialize, Deserialize, Debug)]
struct Req {
    v: u32,
    token: String,
    /// "info" | "list" | "index" | "read"
    op: String,
    path: Option<String>,
    start: Option<u64>,
}

#[derive(Serialize)]
struct Entries<'a> {
    ok: bool,
    entries: &'a [NasEntry],
}

/// JSON 한 줄. 큰 색인도 문자열로 다 만들지 않고 바로 쓴다
fn send(w: &mut impl Write, v: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer(&mut *w, v)?;
    w.write_all(b"\n")
}

fn fail(w: &mut impl Write, error: &str) -> io::Result<()> {
    send(w, &serde_json::json!({ "ok": false, "error": error }))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or_default()
}

/// 연 루트 하나. serve가 읽는 것
pub(crate) struct HostCtx {
    root: PathBuf,
    name: String,
    /// (만든 시각 ms, 항목). 다시 만드는 동안은 이전 것을 준다. 처음 만들기 전은 (0, [])
    index: RwLock<Arc<(u64, Vec<NasEntry>)>>,
}

impl HostCtx {
    pub(crate) fn new(root: PathBuf, name: String) -> Self {
        HostCtx { root, name, index: RwLock::new(Arc::new((0, Vec::new()))) }
    }

    fn index(&self) -> Arc<(u64, Vec<NasEntry>)> {
        self.index.read().unwrap().clone()
    }

    /// 루트를 다시 훑어 색인을 바꿔 끼운다. 항목 수를 돌려준다
    fn rebuild_index(&self, progress: impl FnMut(usize)) -> usize {
        let entries = nasfs::build_index(&self.root, progress);
        let n = entries.len();
        *self.index.write().unwrap() = Arc::new((now_ms(), entries));
        n
    }
}

/// 연결 하나 처리: 요청 한 줄 읽고 답한다. verify가 false면 거절
pub(crate) fn serve(stream: impl Read + Write, host: &HostCtx, verify: &dyn Fn(&str) -> bool) {
    let mut r = BufReader::new(stream);
    let Ok(req) = read_json::<Req>(&mut r) else { return };
    // 요청은 한 줄뿐이라 읽기 버퍼에 남은 것은 없다. 64KB씩 모아 보낸다
    let mut w = BufWriter::with_capacity(64 * 1024, r.into_inner());
    let _ = respond(&mut w, host, verify, &req).and_then(|_| w.flush());
}

fn respond(w: &mut impl Write, host: &HostCtx, verify: &dyn Fn(&str) -> bool, req: &Req) -> io::Result<()> {
    if req.v != VERSION {
        return fail(w, "Drive 앱 버전이 서로 맞지 않습니다. 두 PC 모두 최신 버전으로 업데이트하세요");
    }
    if req.token.is_empty() || !verify(&req.token) {
        return fail(w, REFUSED);
    }
    let path = req.path.as_deref().unwrap_or("/");
    match req.op.as_str() {
        "info" => send(w, &serde_json::json!({ "ok": true, "name": host.name, "version": host.index().0 })),
        "list" => match nasfs::list(&host.root, path) {
            Ok(entries) => send(w, &Entries { ok: true, entries: &entries }),
            Err(e) => fail(w, &e),
        },
        "index" => send(w, &Entries { ok: true, entries: &host.index().1 }),
        "read" => read(w, host, path, req.start.unwrap_or(0)),
        _ => fail(w, "알 수 없는 요청입니다"),
    }
}

fn read(w: &mut impl Write, host: &HostCtx, path: &str, start: u64) -> io::Result<()> {
    let p = match nasfs::resolve_in(&host.root, path) {
        Ok(p) => p,
        Err(e) => return fail(w, &e),
    };
    let opened = File::open(&p).ok().and_then(|f| {
        let m = f.metadata().ok()?;
        m.is_file().then_some((f, m.len()))
    });
    let Some((mut f, size)) = opened else { return fail(w, "파일을 읽을 수 없습니다") };
    f.seek(SeekFrom::Start(start.min(size)))?;
    send(w, &serde_json::json!({ "ok": true, "size": size }))?;
    io::copy(&mut f, w)?;
    Ok(())
}

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    open: bool,
    root: Option<String>,
    /// 색인 항목 수. 만드는 중이면 지금까지 훑은 수
    indexed: usize,
    indexing: bool,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
struct VerifyAsk {
    id: String,
    token: String,
}

/// 열려 있는 동안만 있는 것. 놓으면 변경 감시가 멈추고, 색인 스레드는 깨울 쪽이 다 없어져 끝난다
struct Run {
    ctx: Arc<HostCtx>,
    server: String,
    port: u16,
    daemon: ServiceDaemon,
    fullname: String,
    _watch: Debouncer<RecommendedWatcher>,
    _reindex: mpsc::Sender<()>,
}

#[derive(Default)]
pub struct NasHost {
    run: Mutex<Option<Run>>,
    /// 열고 닫을 때마다 올린다. 이전 실행의 스레드가 늦게 상태를 바꾸거나 연결을 받지 않게
    generation: AtomicU64,
    status: Mutex<HostStatus>,
    /// 통과한 토큰의 SHA-256(16진수) → 확인한 때
    verified: Mutex<HashMap<String, Instant>>,
    /// 화면의 답을 기다리는 확인
    pending: Mutex<HashMap<String, mpsc::Sender<bool>>>,
    seq: AtomicU64,
    /// 지금 처리 중인 연결 수
    active: AtomicUsize,
}

pub fn setup(app: &AppHandle) {
    app.manage(Arc::new(NasHost::default()));
}

/// 앱 종료: 다른 PC 목록에서 바로 빠지도록 mDNS에 알리고 닫는다
pub fn shutdown(app: &AppHandle) {
    if let Some(h) = app.try_state::<Arc<NasHost>>() {
        h.stop(app);
    }
}

impl NasHost {
    /// 같은 루트·이름·서버로 이미 열려 있으면 그대로. 다르면 닫고 새로 연다
    fn start(self: &Arc<Self>, app: &AppHandle, root: PathBuf, name: String, server: String) -> Result<(), String> {
        if self.run.lock().unwrap().as_ref().is_some_and(|r| r.ctx.root == root && r.ctx.name == name && r.server == server) {
            return Ok(());
        }
        self.stop(app);
        let run_gen = self.generation.load(SeqCst);
        let res = self.open(app, run_gen, root, name, server);
        if let Err(e) = &res {
            self.set_status(app, run_gen, |s| s.error = Some(e.clone()));
        }
        res
    }

    fn open(self: &Arc<Self>, app: &AppHandle, run_gen: u64, root: PathBuf, name: String, server: String) -> Result<(), String> {
        if !root.is_dir() {
            return Err("폴더를 찾을 수 없습니다".into());
        }
        let identity = Arc::new(tls::Identity::new()?);
        let listener = TcpListener::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        // 변경 감시와 하루 타이머가 같은 색인 스레드를 깨운다
        let (reindex, wake) = mpsc::channel();
        let tx = reindex.clone();
        let mut watch = new_debouncer(REINDEX_DEBOUNCE, move |_| {
            let _ = tx.send(());
        })
        .map_err(|e| e.to_string())?;
        watch.watcher().watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;

        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        let instance = format!("udrive-nas-{}", &identity.fingerprint[..16]);
        let version = VERSION.to_string();
        let props = [("v", version.as_str()), ("fp", identity.fingerprint.as_str()), ("name", name.as_str()), ("server", server.as_str())];
        let registered = ServiceInfo::new(SERVICE, &instance, &format!("{instance}.local."), "", port, &props[..])
            .map(|info| info.enable_addr_auto())
            .and_then(|info| {
                let fullname = info.get_fullname().to_string();
                daemon.register(info).map(|_| fullname)
            });
        let fullname = match registered {
            Ok(f) => f,
            Err(e) => {
                let _ = daemon.shutdown();
                return Err(e.to_string());
            }
        };

        let ctx = Arc::new(HostCtx::new(root.clone(), name));
        *self.run.lock().unwrap() = Some(Run { ctx: ctx.clone(), server, port, daemon, fullname, _watch: watch, _reindex: reindex });
        self.set_status(app, run_gen, |s| {
            s.open = true;
            s.root = Some(root.to_string_lossy().into_owned());
        });
        self.accept_on(app, run_gen, listener, identity, ctx.clone());
        self.index_on(app, run_gen, ctx, wake);
        Ok(())
    }

    fn stop(&self, app: &AppHandle) {
        let run = {
            let mut s = self.status.lock().unwrap();
            self.generation.fetch_add(1, SeqCst);
            *s = HostStatus::default();
            self.run.lock().unwrap().take()
        };
        // 다른 서버로 다시 열 수 있으니 확인한 토큰도 잊는다
        self.verified.lock().unwrap().clear();
        if let Some(run) = run {
            // 받는 쪽 목록에서 바로 빠지도록 goodbye를 보내고 끝낸다
            if let Ok(rx) = run.daemon.unregister(&run.fullname) {
                let _ = rx.recv_timeout(Duration::from_secs(1));
            }
            let _ = run.daemon.shutdown();
            // 리스너 스레드를 깨운다. 세대가 바뀐 것을 보고 끝난다
            let _ = TcpStream::connect_timeout(&([127, 0, 0, 1], run.port).into(), Duration::from_secs(1));
        }
        let _ = app.emit("nas-host-status", HostStatus::default());
    }

    /// 이번 실행(run_gen)일 때만 상태를 바꾸고 화면에 알린다
    fn set_status(&self, app: &AppHandle, run_gen: u64, f: impl FnOnce(&mut HostStatus)) {
        let s = {
            let mut s = self.status.lock().unwrap();
            if self.generation.load(SeqCst) != run_gen {
                return;
            }
            f(&mut s);
            s.clone()
        };
        let _ = app.emit("nas-host-status", s);
    }

    fn accept_on(self: &Arc<Self>, app: &AppHandle, run_gen: u64, listener: TcpListener, identity: Arc<tls::Identity>, ctx: Arc<HostCtx>) {
        let (host, app) = (self.clone(), app.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if host.generation.load(SeqCst) != run_gen {
                    break;
                }
                let Ok(stream) = stream else { continue };
                if host.active.fetch_add(1, SeqCst) >= MAX_CONNS {
                    host.active.fetch_sub(1, SeqCst);
                    continue; // drop하면 끊긴다
                }
                let (host, app, identity, ctx) = (host.clone(), app.clone(), identity.clone(), ctx.clone());
                std::thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
                    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
                    if let Ok(tls) = identity.accept(stream) {
                        let ask = |id: &str, token: &str| {
                            let _ = app.emit("nas-verify", VerifyAsk { id: id.into(), token: token.into() });
                        };
                        serve(tls, &ctx, &|token| host.check(token, |id| ask(id, token)));
                    }
                    host.active.fetch_sub(1, SeqCst);
                });
            }
        });
    }

    /// 열자마자 한 번, 그 뒤 변경 감시가 깨우거나 하루가 지나면 다시 만든다
    fn index_on(self: &Arc<Self>, app: &AppHandle, run_gen: u64, ctx: Arc<HostCtx>, wake: mpsc::Receiver<()>) {
        let (host, app) = (self.clone(), app.clone());
        std::thread::spawn(move || {
            let mut wait = Duration::ZERO;
            // ponytail: 닫아도 만들던 색인은 끝까지 훑는다. 3TB에서 너무 길면 build_index에 중단 신호를 넘긴다
            while !matches!(wake.recv_timeout(wait), Err(mpsc::RecvTimeoutError::Disconnected)) {
                while wake.try_recv().is_ok() {} // 만드는 동안 쌓인 깨우기는 한 번으로
                host.set_status(&app, run_gen, |s| s.indexing = true);
                let n = ctx.rebuild_index(|n| host.set_status(&app, run_gen, |s| s.indexed = n));
                host.set_status(&app, run_gen, |s| {
                    s.indexing = false;
                    s.indexed = n;
                });
                wait = REINDEX_EVERY;
            }
        });
    }

    /// 토큰 확인. 10분 안에 통과한 토큰이면 바로 true, 아니면 ask(id)로 화면에 묻고 답을 기다린다. 통과한 것만 기억한다
    fn check(&self, token: &str, ask: impl FnOnce(&str)) -> bool {
        let key = tls::fingerprint(token.as_bytes());
        {
            let mut v = self.verified.lock().unwrap();
            v.retain(|_, t| t.elapsed() < VERIFY_TTL);
            if v.contains_key(&key) {
                return true;
            }
        }
        let id = format!("v{}", self.seq.fetch_add(1, SeqCst) + 1);
        let ok = self.wait_verify(&id, VERIFY_TIMEOUT, || ask(&id));
        if ok {
            self.verified.lock().unwrap().insert(key, Instant::now());
        }
        ok
    }

    /// id로 답 받을 자리를 만들고 ask로 물은 뒤 기다린다. timeout까지 답이 없으면 false
    fn wait_verify(&self, id: &str, timeout: Duration, ask: impl FnOnce()) -> bool {
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id.to_string(), tx);
        ask();
        let ok = rx.recv_timeout(timeout).unwrap_or(false);
        self.pending.lock().unwrap().remove(id);
        ok
    }

    fn reply(&self, id: &str, ok: bool) {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            let _ = tx.send(ok);
        }
    }
}

/// 루트를 열고 mDNS로 알린다. server는 Seafile 주소(받는 쪽이 자기 서버와 같은지 본다)
#[tauri::command]
pub fn nas_host_start(app: AppHandle, state: State<Arc<NasHost>>, root: String, name: String, server: String) -> Result<(), String> {
    let server = server.trim().trim_end_matches('/').to_lowercase();
    state.inner().start(&app, PathBuf::from(root), name, server)
}

#[tauri::command]
pub fn nas_host_stop(app: AppHandle, state: State<Arc<NasHost>>) {
    state.stop(&app);
}

#[tauri::command]
pub fn nas_host_status(state: State<Arc<NasHost>>) -> HostStatus {
    state.status.lock().unwrap().clone()
}

/// nas-verify에 대한 화면의 답: 그 토큰으로 getAccount()가 됐는지
#[tauri::command]
pub fn nas_verify_reply(state: State<Arc<NasHost>>, id: String, ok: bool) {
    state.reply(&id, ok);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("seadrive-nas-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn req(op: &str, path: Option<&str>, start: Option<u64>) -> Req {
        Req { v: VERSION, token: "t".into(), op: op.into(), path: path.map(String::from), start }
    }

    /// 루프백에 serve를 하나 띄우고 요청 한 번: (응답 줄, 그 뒤 바이트)
    fn ask(ctx: Arc<HostCtx>, ok: bool, r: Req) -> (serde_json::Value, Vec<u8>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            serve(s, &ctx, &|_| ok);
        });
        let mut s = TcpStream::connect(addr).unwrap();
        send(&mut s, &r).unwrap();
        let mut rd = BufReader::new(s);
        let head: serde_json::Value = read_json(&mut rd).unwrap();
        let mut rest = Vec::new();
        rd.read_to_end(&mut rest).unwrap();
        h.join().unwrap();
        (head, rest)
    }

    #[test]
    fn refuses_without_verified_token() {
        let ctx = Arc::new(HostCtx::new(temp_dir("refuse"), "디자인나스".into()));
        let (head, _) = ask(ctx, false, req("list", Some("/"), None));
        assert_eq!(head, serde_json::json!({ "ok": false, "error": "로그인 확인에 실패했습니다" }));
    }

    #[test]
    fn info_list_and_read_from_offset() {
        let root = temp_dir("serve");
        std::fs::write(root.join("a.bin"), b"0123456789").unwrap();
        let ctx = Arc::new(HostCtx::new(root, "디자인나스".into()));

        let (info, _) = ask(ctx.clone(), true, req("info", None, None));
        assert_eq!(info["ok"], true);
        assert_eq!(info["name"], "디자인나스");
        assert!(info["version"].is_u64());

        let (list, _) = ask(ctx.clone(), true, req("list", Some("/"), None));
        let names: Vec<_> = list["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["a.bin"]);

        let (head, body) = ask(ctx, true, req("read", Some("/a.bin"), Some(4)));
        assert_eq!(head, serde_json::json!({ "ok": true, "size": 10 }));
        assert_eq!(body, b"456789");
    }

    #[test]
    fn index_serves_built_entries() {
        let root = temp_dir("index");
        std::fs::create_dir(root.join("사진")).unwrap();
        std::fs::write(root.join("사진/x.jpg"), "x").unwrap();
        let ctx = Arc::new(HostCtx::new(root, "디자인나스".into()));
        ctx.rebuild_index(|_| {});
        let (head, _) = ask(ctx.clone(), true, req("index", None, None));
        let mut paths: Vec<_> = head["entries"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap().to_string()).collect();
        paths.sort();
        assert_eq!(paths, ["/사진", "/사진/x.jpg"]);
        let (info, _) = ask(ctx, true, req("info", None, None));
        assert!(info["version"].as_u64().unwrap() > 0);
    }

    #[test]
    fn read_outside_root_is_refused() {
        let ctx = Arc::new(HostCtx::new(temp_dir("outside"), "디자인나스".into()));
        let (head, body) = ask(ctx, true, req("read", Some("/../x"), None));
        assert_eq!(head["ok"], false);
        assert!(body.is_empty());
    }

    #[test]
    fn verify_timeout_refuses() {
        let host = NasHost::default();
        assert!(!host.wait_verify("v1", Duration::from_millis(50), || {}));
        // 답이 오면 그 값. 끝난 확인은 남지 않는다
        assert!(host.wait_verify("v2", Duration::from_secs(5), || host.reply("v2", true)));
        assert!(host.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn only_accepted_tokens_are_remembered() {
        let host = NasHost::default();
        let asked = Cell::new(0);
        let no = |id: &str| {
            asked.set(asked.get() + 1);
            host.reply(id, false)
        };
        assert!(!host.check("bad", no));
        assert!(!host.check("bad", no));
        assert_eq!(asked.get(), 2, "거절된 토큰은 기억하지 않고 다시 묻는다");
        assert!(host.check("good", |id| host.reply(id, true)));
        assert!(host.check("good", |_| panic!("캐시에 있으면 묻지 않는다")));
        // 토큰 원문은 남기지 않는다
        assert!(host.verified.lock().unwrap().keys().all(|k| k.len() == 64 && k != "good"));
    }
}
