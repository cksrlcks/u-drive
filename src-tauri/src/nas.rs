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
//! 인증은 없다. 같은 사무실 네트워크의 Drive 앱은 누구나 읽기 전용으로 본다(토큰을 보내지 않는다).

use crate::localfs::plain_name;
use crate::nasfs::{self, NasEntry};
use crate::nearby::read_json;
use crate::tls;
use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent, ServiceInfo};
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, Debouncer};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::{mpsc, Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const SERVICE: &str = "_udrive-nas._tcp.local.";
/// 요청의 v, mDNS TXT의 v
const VERSION: u32 = 1;
/// 상대가 이만큼 아무것도 보내지 않으면 끊는다
const IO_TIMEOUT: Duration = Duration::from_secs(30);
/// 동시에 처리하는 연결 수. 넘으면 바로 끊는다(연결마다 스레드 하나)
const MAX_CONNS: usize = 64;
/// 마지막 변경 뒤 이만큼 조용하면 색인을 다시 만든다
const REINDEX_DEBOUNCE: Duration = Duration::from_secs(60);
/// 감시가 놓친 변경을 위해 하루 한 번 다시 만든다
const REINDEX_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// 받는 쪽: 연결·TLS·응답이 끊기거나 깨졌을 때 모두 이 문구
const CONNECT: &str = "디자인나스에 연결할 수 없습니다. 서버 PC의 Drive 앱이 켜져 있는지 확인하세요";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// 응답 첫 줄 한도. 색인은 한 줄이 수십 MB, 큰 폴더 목록도 256KB를 넘는다
const MAX_REPLY: u64 = 512 * 1024 * 1024;

#[derive(Serialize, Deserialize, Debug)]
struct Req {
    v: u32,
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

/// 연결 하나 처리: 요청 한 줄 읽고 답한다
pub(crate) fn serve(stream: impl Read + Write, host: &HostCtx) {
    let mut r = BufReader::new(stream);
    let Ok(req) = read_json::<Req>(&mut r) else { return };
    // 요청은 한 줄뿐이라 읽기 버퍼에 남은 것은 없다. 64KB씩 모아 보낸다
    let mut w = BufWriter::with_capacity(64 * 1024, r.into_inner());
    let _ = respond(&mut w, host, &req).and_then(|_| w.flush());
}

fn respond(w: &mut impl Write, host: &HostCtx, req: &Req) -> io::Result<()> {
    if req.v != VERSION {
        return fail(w, "Drive 앱 버전이 서로 맞지 않습니다. 두 PC 모두 최신 버전으로 업데이트하세요");
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
    /// 지금 처리 중인 연결 수
    active: AtomicUsize,
}

pub fn setup(app: &AppHandle) {
    app.manage(Arc::new(NasHost::default()));
    app.manage(Arc::new(NasClient::default()));
}

/// 앱 종료: 다른 PC 목록에서 바로 빠지도록 mDNS에 알리고 닫는다
pub fn shutdown(app: &AppHandle) {
    if let Some(h) = app.try_state::<Arc<NasHost>>() {
        h.stop(app);
    }
    if let Some(c) = app.try_state::<Arc<NasClient>>() {
        c.stop(app);
    }
}

/// Seafile 주소를 한 모양으로: 알리는 쪽과 찾는 쪽이 같은 서버면 늘 같은 문자열
fn norm_server(server: &str) -> String {
    server.trim().trim_end_matches('/').to_lowercase()
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
        self.accept_on(run_gen, listener, identity, ctx.clone());
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

    fn accept_on(self: &Arc<Self>, run_gen: u64, listener: TcpListener, identity: Arc<tls::Identity>, ctx: Arc<HostCtx>) {
        let host = self.clone();
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
                let (host, identity, ctx) = (host.clone(), identity.clone(), ctx.clone());
                std::thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
                    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
                    if let Ok(tls) = identity.accept(stream) {
                        serve(tls, &ctx);
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
}

/// 루트를 열고 mDNS로 알린다. server는 Seafile 주소(받는 쪽이 자기 서버와 같은지 본다)
#[tauri::command]
pub fn nas_host_start(app: AppHandle, state: State<Arc<NasHost>>, root: String, name: String, server: String) -> Result<(), String> {
    state.inner().start(&app, PathBuf::from(root), name, norm_server(&server))
}

#[tauri::command]
pub fn nas_host_stop(app: AppHandle, state: State<Arc<NasHost>>) {
    state.stop(&app);
}

#[tauri::command]
pub fn nas_host_status(state: State<Arc<NasHost>>) -> HostStatus {
    state.status.lock().unwrap().clone()
}

// ── 받는 쪽 ─────────────────────────────────────────────

/// mDNS로 찾은 디자인나스 하나
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NasPeer {
    /// mDNS fullname
    id: String,
    name: String,
    addrs: Vec<SocketAddr>,
    /// 인증서 지문. 연결할 때 이것과 같은 인증서인지 본다
    fp: String,
}

#[derive(Serialize)]
pub struct NasInfo {
    name: String,
    /// 색인 만든 시각 ms. 첫 색인 전이면 0
    version: u64,
}

/// 응답 첫 줄. 여러 op의 필드를 한 구조체로 받는다(큰 색인을 Value로 한 번 더 만들지 않게)
#[derive(Deserialize, Default)]
#[serde(default)]
struct Reply {
    ok: bool,
    error: Option<String>,
    name: String,
    version: u64,
    entries: Vec<NasEntry>,
    size: u64,
}

#[derive(Serialize, Clone)]
struct Progress {
    id: String,
    got: u64,
    total: u64,
}

#[derive(Default)]
pub struct NasClient {
    /// (찾는 서버, 데몬)
    browse: Mutex<Option<(String, ServiceDaemon)>>,
    /// 찾기를 새로 할 때마다 올린다. 이전 찾기의 늦은 이벤트를 버리려고(peers 잠금 안에서 본다)
    generation: AtomicU64,
    peers: Mutex<HashMap<String, NasPeer>>,
}

impl NasClient {
    /// 같은 서버로 찾는 중이면 그대로. 다르면 새로 찾는다
    fn browse(self: &Arc<Self>, app: &AppHandle, server: String) -> Result<(), String> {
        if self.browse.lock().unwrap().as_ref().is_some_and(|(s, _)| *s == server) {
            return Ok(());
        }
        self.stop(app);
        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        let events = match daemon.browse(SERVICE) {
            Ok(e) => e,
            Err(e) => {
                let _ = daemon.shutdown();
                return Err(e.to_string());
            }
        };
        let run_gen = self.generation.load(SeqCst);
        *self.browse.lock().unwrap() = Some((server.clone(), daemon));
        let (c, app) = (self.clone(), app.clone());
        // daemon을 shutdown하면 events가 끊겨 스레드도 끝난다
        std::thread::spawn(move || {
            for ev in events {
                if !c.on_event(&app, run_gen, &server, ev) {
                    break;
                }
            }
        });
        Ok(())
    }

    fn stop(&self, app: &AppHandle) {
        {
            let mut peers = self.peers.lock().unwrap();
            self.generation.fetch_add(1, SeqCst);
            peers.clear();
        }
        if let Some((_, daemon)) = self.browse.lock().unwrap().take() {
            let _ = daemon.shutdown();
        }
        let _ = app.emit("nas-peers", Vec::<NasPeer>::new());
    }

    /// 목록을 고치고 바뀌었으면 알린다. 이전 찾기(run_gen)의 이벤트면 false
    fn on_event(&self, app: &AppHandle, run_gen: u64, server: &str, ev: ServiceEvent) -> bool {
        let list = {
            let mut peers = self.peers.lock().unwrap();
            if self.generation.load(SeqCst) != run_gen {
                return false;
            }
            let changed = match ev {
                ServiceEvent::ServiceResolved(s) => match peer_from(&s, server) {
                    Some(p) => {
                        peers.insert(p.id.clone(), p);
                        true
                    }
                    // 다른 서버·버전으로 다시 알렸으면 뺀다
                    None => peers.remove(s.get_fullname()).is_some(),
                },
                ServiceEvent::ServiceRemoved(_, fullname) => peers.remove(&fullname).is_some(),
                _ => false,
            };
            if !changed {
                return true;
            }
            sorted(&peers)
        };
        let _ = app.emit("nas-peers", list);
        true
    }

    fn peer(&self, id: &str) -> Result<NasPeer, String> {
        self.peers.lock().unwrap().get(id).cloned().ok_or_else(|| CONNECT.into())
    }

}

/// 요청 한 번(새 연결). 연결·응답 기다림은 async 실행기 밖에서
async fn call(state: &NasClient, peer: &str, req: Req) -> Result<Reply, String> {
    let peer = state.peer(peer)?;
    tauri::async_runtime::spawn_blocking(move || request(connect(&peer)?, &req).map(|(r, _)| r)).await.map_err(|e| e.to_string())?
}

fn sorted(peers: &HashMap<String, NasPeer>) -> Vec<NasPeer> {
    let mut v: Vec<NasPeer> = peers.values().cloned().collect();
    v.sort_by(|a, b| (&a.name, &a.id).cmp(&(&b.name, &b.id)));
    v
}

/// 같은 서버·버전이고 지문·IPv4 주소가 있는 것만
fn peer_from(s: &ResolvedService, server: &str) -> Option<NasPeer> {
    let prop = |k: &str| s.get_property_val_str(k).unwrap_or_default().to_string();
    if prop("server") != server || prop("v") != VERSION.to_string() || prop("fp").len() != 64 {
        return None;
    }
    let addrs: Vec<SocketAddr> = s.get_addresses().iter().map(|ip| ip.to_ip_addr()).filter(|ip| ip.is_ipv4()).map(|ip| SocketAddr::new(ip, s.get_port())).collect();
    if addrs.is_empty() {
        return None;
    }
    Some(NasPeer { id: s.get_fullname().to_string(), name: prop("name"), addrs, fp: prop("fp") })
}

/// 주소를 차례로 5초씩 시도하고, 알린 지문과 같은 인증서인지 확인해 TLS로 감싼다
fn connect(peer: &NasPeer) -> Result<impl Read + Write, String> {
    for a in &peer.addrs {
        let Ok(s) = TcpStream::connect_timeout(a, CONNECT_TIMEOUT) else { continue };
        let _ = s.set_read_timeout(Some(IO_TIMEOUT));
        let _ = s.set_write_timeout(Some(IO_TIMEOUT));
        // 낡은 주소가 다른 PC로 이어지면 지문이 달라 실패한다: 다음 주소로
        if let Ok(t) = tls::connect(s, &peer.fp) {
            return Ok(t);
        }
    }
    Err(CONNECT.into())
}

/// 요청 한 줄을 보내고 응답 첫 줄을 읽는다. ok:false면 제공 쪽 문구. 본문(read)은 돌려준 읽기에서 이어 읽는다
fn request<S: Read + Write>(mut stream: S, req: &Req) -> Result<(Reply, BufReader<S>), String> {
    send(&mut stream, req).and_then(|_| stream.flush()).map_err(|_| CONNECT)?;
    let mut r = BufReader::with_capacity(64 * 1024, stream);
    let mut line = Vec::new();
    r.by_ref().take(MAX_REPLY).read_until(b'\n', &mut line).map_err(|_| CONNECT)?;
    if line.last() != Some(&b'\n') {
        return Err(CONNECT.into());
    }
    let mut reply: Reply = serde_json::from_slice(&line).map_err(|_| CONNECT)?;
    if !reply.ok {
        return Err(reply.error.unwrap_or_else(|| CONNECT.into()));
    }
    // 제공 쪽은 인증 없는 네트워크 상대다. 화면이 이름을 내 PC 경로에 붙이므로 한 칸짜리 이름만 받는다(../·\ 들어간 것은 버림)
    reply.entries.retain(|e| plain_name(&e.name) == e.name);
    Ok((reply, r))
}

/// read 요청을 보내고 본문을 dest에 쓴다. progress(받은, 전체)는 시작에 한 번, 조각마다 한 번.
/// 끊기거나 덜 오거나 쓰기에 실패하면 dest를 지운다. 거절되면 dest를 만들지 않는다
fn receive_to(stream: impl Read + Write, req: &Req, dest: &Path, mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let (reply, mut r) = request(stream, req)?;
    // 제공 쪽은 close_notify 없이 끊으므로 끝까지(read_to_end) 읽지 않고 딱 이만큼만
    let total = reply.size.saturating_sub(req.start.unwrap_or(0));
    let saving = |e: io::Error| format!("파일을 저장할 수 없습니다: {e}");
    let mut out = File::create(dest).map_err(saving)?;
    let res = (|| {
        let mut buf = vec![0u8; 256 * 1024];
        let mut got = 0;
        progress(0, total);
        while got < total {
            let want = (total - got).min(buf.len() as u64) as usize;
            let n = r.read(&mut buf[..want]).map_err(|_| CONNECT.to_string())?;
            if n == 0 {
                return Err(CONNECT.to_string());
            }
            out.write_all(&buf[..n]).map_err(saving)?;
            got += n as u64;
            progress(got, total);
        }
        Ok(())
    })();
    drop(out);
    if res.is_err() {
        let _ = fs::remove_file(dest);
    }
    res
}

fn ask_req(op: &str, path: Option<String>) -> Req {
    Req { v: VERSION, op: op.into(), path, start: None }
}

/// 로그인한 Seafile 서버(server)의 디자인나스를 찾는다. 목록은 nas-peers 이벤트로
#[tauri::command]
pub fn nas_browse(app: AppHandle, state: State<Arc<NasClient>>, server: String) -> Result<(), String> {
    state.inner().browse(&app, norm_server(&server))
}

#[tauri::command]
pub fn nas_peers(state: State<Arc<NasClient>>) -> Vec<NasPeer> {
    sorted(&state.peers.lock().unwrap())
}

#[tauri::command]
pub async fn nas_info(state: State<'_, Arc<NasClient>>, peer: String) -> Result<NasInfo, String> {
    let r = call(&state, &peer, ask_req("info", None)).await?;
    Ok(NasInfo { name: r.name, version: r.version })
}

#[tauri::command]
pub async fn nas_list(state: State<'_, Arc<NasClient>>, peer: String, path: String) -> Result<Vec<NasEntry>, String> {
    Ok(call(&state, &peer, ask_req("list", Some(path))).await?.entries)
}

#[tauri::command]
pub async fn nas_index(state: State<'_, Arc<NasClient>>, peer: String) -> Result<Vec<NasEntry>, String> {
    Ok(call(&state, &peer, ask_req("index", None)).await?.entries)
}

/// path를 dest(화면이 고른 PC 경로)에 내려받는다. 진행은 nas-download {id, got, total}로 100ms에 한 번(끝은 꼭)
#[tauri::command]
pub async fn nas_download(app: AppHandle, state: State<'_, Arc<NasClient>>, peer: String, path: String, dest: String, id: String) -> Result<(), String> {
    let peer = state.peer(&peer)?;
    // 큰 파일은 몇 분 걸린다: async 실행기 스레드를 붙잡지 않게 따로 돌린다
    tauri::async_runtime::spawn_blocking(move || {
        let mut tick = crate::nearby::Ticker::default();
        receive_to(connect(&peer)?, &ask_req("read", Some(path)), Path::new(&dest), |got, total| {
            if got == total || tick.due() {
                let _ = app.emit("nas-download", Progress { id: id.clone(), got, total });
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("seadrive-nas-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn req(op: &str, path: Option<&str>, start: Option<u64>) -> Req {
        Req { v: VERSION, op: op.into(), path: path.map(String::from), start }
    }

    /// 루프백에 serve를 하나 띄우고 요청 한 번: (응답 줄, 그 뒤 바이트)
    fn ask(ctx: Arc<HostCtx>, r: Req) -> (serde_json::Value, Vec<u8>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            serve(s, &ctx);
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
    fn request_has_no_token() {
        let line = serde_json::to_string(&ask_req("list", Some("/".into()))).unwrap();
        assert!(!line.contains("token"), "{line}");
    }

    #[test]
    fn info_list_and_read_from_offset() {
        let root = temp_dir("serve");
        std::fs::write(root.join("a.bin"), b"0123456789").unwrap();
        let ctx = Arc::new(HostCtx::new(root, "디자인나스".into()));

        let (info, _) = ask(ctx.clone(), req("info", None, None));
        assert_eq!(info["ok"], true);
        assert_eq!(info["name"], "디자인나스");
        assert!(info["version"].is_u64());

        let (list, _) = ask(ctx.clone(), req("list", Some("/"), None));
        let names: Vec<_> = list["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["a.bin"]);

        let (head, body) = ask(ctx, req("read", Some("/a.bin"), Some(4)));
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
        let (head, _) = ask(ctx.clone(), req("index", None, None));
        let mut paths: Vec<_> = head["entries"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap().to_string()).collect();
        paths.sort();
        assert_eq!(paths, ["/사진", "/사진/x.jpg"]);
        let (info, _) = ask(ctx, req("info", None, None));
        assert!(info["version"].as_u64().unwrap() > 0);
    }

    #[test]
    fn read_outside_root_is_refused() {
        let ctx = Arc::new(HostCtx::new(temp_dir("outside"), "디자인나스".into()));
        let (head, body) = ask(ctx, req("read", Some("/../x"), None));
        assert_eq!(head["ok"], false);
        assert!(body.is_empty());
    }

    /// 루프백에 serve를 하나 띄운다(연결 한 번). 클라이언트 쪽 테스트용
    fn host(ctx: Arc<HostCtx>) -> (std::net::SocketAddr, std::thread::JoinHandle<()>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        (addr, std::thread::spawn(move || serve(l.accept().unwrap().0, &ctx)))
    }

    #[test]
    fn client_request_roundtrip() {
        let root = temp_dir("client");
        std::fs::write(root.join("a.bin"), b"0123456789").unwrap();
        let ctx = Arc::new(HostCtx::new(root, "디자인나스".into()));

        let (addr, h) = host(ctx.clone());
        let (reply, _) = request(TcpStream::connect(addr).unwrap(), &req("list", Some("/"), None)).unwrap();
        h.join().unwrap();
        let names: Vec<_> = reply.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["a.bin"]);

        // 첫 색인 전 version 0도 정상 응답
        let (addr, h) = host(ctx.clone());
        let (reply, _) = request(TcpStream::connect(addr).unwrap(), &req("info", None, None)).unwrap();
        h.join().unwrap();
        assert_eq!((reply.name.as_str(), reply.version), ("디자인나스", 0));
    }

    #[test]
    fn client_drops_entries_with_path_names() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        // 가짜 제공 쪽: 이름에 경로를 넣어 받는 PC의 다른 폴더에 쓰게 하려 한다
        let h = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut r = BufReader::new(s);
            let _: Req = read_json(&mut r).unwrap();
            let e = |name: &str| NasEntry { name: name.into(), kind: "file".into(), size: 1, mtime: 0.0, path: format!("/{name}") };
            let entries = ["ok.psd", "../x", r"a\b", "..", "", r"..\..\Startup\x.bat"].map(e);
            send(r.get_mut(), &Entries { ok: true, entries: &entries }).unwrap();
        });
        let (reply, _) = request(TcpStream::connect(addr).unwrap(), &req("list", Some("/"), None)).unwrap();
        h.join().unwrap();
        let names: Vec<_> = reply.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["ok.psd"]);
    }

    #[test]
    fn download_writes_file_and_reports_progress() {
        let root = temp_dir("dl");
        let data: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(root.join("big.bin"), &data).unwrap();
        let ctx = Arc::new(HostCtx::new(root.clone(), "디자인나스".into()));
        let dest = root.join("받은.bin");

        let (addr, h) = host(ctx.clone());
        let mut last = (1, 0);
        receive_to(TcpStream::connect(addr).unwrap(), &req("read", Some("/big.bin"), None), &dest, |g, t| last = (g, t)).unwrap();
        h.join().unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
        assert_eq!(last, (data.len() as u64, data.len() as u64));

        // 거절되면 dest를 만들지 않는다
        let other = root.join("없음.bin");
        let (addr, h) = host(ctx);
        assert!(receive_to(TcpStream::connect(addr).unwrap(), &req("read", Some("/../x"), None), &other, |_, _| {}).is_err());
        h.join().unwrap();
        assert!(!other.exists());
    }

    #[test]
    fn download_removes_partial_file() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        // 가짜 제공 쪽: 100바이트라 해 놓고 10바이트만 보내고 끊는다
        let h = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut r = BufReader::new(s);
            let _: Req = read_json(&mut r).unwrap();
            let mut s = r.into_inner();
            s.write_all(b"{\"ok\":true,\"size\":100}\n0123456789").unwrap();
        });
        let dest = temp_dir("partial").join("a.bin");
        let err = receive_to(TcpStream::connect(addr).unwrap(), &req("read", Some("/a.bin"), None), &dest, |_, _| {}).unwrap_err();
        h.join().unwrap();
        assert_eq!(err, CONNECT);
        assert!(!dest.exists());
    }
}
