//! 바로 보내기. 같은 네트워크의 U-Drive끼리 mDNS(_udrive._tcp)로 서로 찾고, 파일은 서버를 거치지 않고 TCP로 직접 보낸다.
//! 같은 Seafile 서버에 로그인한 U-Drive끼리만 서로 보인다.
//!
//! 전송 한 번 = TCP 연결 하나. 연결은 TLS 1.3이고, 보내는 쪽은 상대 인증서가 mDNS로 알린 지문과 같은지 확인한다(tls.rs)
//!   보내는 쪽 → 헤더 한 줄(JSON: 보낸 사람·파일 목록)
//!   받는 쪽   → 답 한 줄({"ok":true} / {"ok":false,"reason":..}). 사용자에게 물어보고 답한다
//!   보내는 쪽 → 파일 바이트를 목록 순서대로 이어서
//!   받는 쪽   → 다 저장하면 {"ok":true,"done":true}

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::tls;

const SERVICE: &str = "_udrive._tcp.local.";
/// 2: TLS. mDNS TXT의 v도 같은 값이고, 다른 버전은 목록에 넣지 않는다
const VERSION: u32 = 2;
/// 받을지 묻고 기다리는 시간. 지나면 거절
const ASK_TIMEOUT: Duration = Duration::from_secs(60);
/// 전송 중 상대가 이만큼 아무것도 보내지 않으면 끊는다
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LINE: u64 = 256 * 1024;
/// 동시에 받는 연결 수. 넘으면 바로 끊는다(연결마다 스레드 하나)
const MAX_CONNS: usize = 8;
/// 동시에 묻는 받기 요청 수. 넘거나 같은 PC가 이미 묻는 중이면 "busy"로 거절한다(팝업 폭탄 방지)
const MAX_ASKS: usize = 4;
/// 받기 요청 팝업 창. 화면(main.tsx)은 이 이름을 보고 팝업만 그린다
const POPUP: &str = "nearby-offer";
const POPUP_SIZE: (f64, f64) = (360.0, 314.0);

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Person {
    name: String,
    email: String,
    device: String,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct FileMeta {
    name: String,
    size: u64,
}

#[derive(Serialize, Deserialize, Debug)]
struct Header {
    v: u32,
    server: String,
    from: Person,
    files: Vec<FileMeta>,
}

#[derive(Serialize, Deserialize, Debug, Default)]
struct Reply {
    #[serde(default)]
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    done: bool,
}

impl Reply {
    fn no(reason: &str) -> Self {
        Reply { ok: false, reason: Some(reason.into()), done: false }
    }
}

#[derive(Clone, Serialize)]
pub struct Peer {
    id: String,
    #[serde(flatten)]
    person: Person,
    #[serde(skip)]
    addrs: Vec<SocketAddr>,
    /// 상대가 mDNS로 알린 인증서 지문. 연결할 때 이것과 같은 인증서인지 본다
    #[serde(skip)]
    fp: String,
}

#[derive(Clone, PartialEq)]
struct Me {
    person: Person,
    server: String,
}

#[derive(Clone, Serialize)]
pub struct Offer {
    id: String,
    from: Person,
    files: Vec<FileMeta>,
    total: u64,
}

/// 화면의 전송 패널 한 줄. 보내기·받기 모두 같은 모양으로 보낸다
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Transfer {
    id: String,
    send: bool,
    peer: String,
    name: String,
    count: usize,
    done: u64,
    total: u64,
    /// asking(상대 답 기다림) · active · done · declined · failed · canceled
    status: &'static str,
    error: Option<String>,
    /// 받기 완료: PC에 받은 첫 파일 경로(폴더에서 보기용)
    path: Option<String>,
    /// 드라이브로 받기 완료: 메인 창이 드라이브에 올릴 임시 파일. 다 올리면 nearby_cleanup
    upload: Vec<String>,
    /// 끝났지만 알려 줄 것(업로드 상한을 넘어 PC에 받은 파일 등)
    note: Option<String>,
    /// 드라이브로 받기: 팝업이 답할 때 고른 드라이브 폴더. 메인 창이 그대로 올린다
    target: Option<serde_json::Value>,
}

impl Transfer {
    fn emit(&self, app: &AppHandle) {
        let _ = app.emit("nearby-transfer", self);
    }
}

/// 사용자에게 묻는 중인 받기 요청
struct Ask {
    tx: mpsc::Sender<Answer>,
    offer: Offer,
    ip: IpAddr,
}

enum Answer {
    /// target: Some(드라이브 폴더)면 드라이브로 받기. pc_dir: PC에 받을 폴더(없으면 다운로드 폴더)
    Accept { target: Option<serde_json::Value>, pc_dir: Option<PathBuf> },
    Decline,
}

pub struct Nearby {
    /// 이 실행의 무작위 id. mDNS에서 자기 자신을 거른다
    id: String,
    me: Mutex<Option<Me>>,
    daemon: Mutex<Option<(ServiceDaemon, String)>>,
    /// start할 때마다 올린다. 이전 browse 스레드가 늦게 보낸 이벤트를 버리려고
    generation: AtomicU64,
    port: Mutex<Option<u16>>,
    /// 받기용 인증서. 포트를 열 때 한 번 만든다
    identity: Mutex<Option<Arc<tls::Identity>>>,
    /// 지금 받고 있는 연결 수
    active: AtomicUsize,
    peers: Mutex<HashMap<String, Peer>>,
    /// 사용자에게 묻는 중인 받기
    asks: Mutex<HashMap<String, Ask>>,
    /// 진행 중인 연결. 취소하면 shutdown해서 막힌 읽기·쓰기를 깨운다
    conns: Mutex<HashMap<String, TcpStream>>,
    canceled: Mutex<HashSet<String>>,
    seq: AtomicU64,
}

pub fn setup(app: &AppHandle) {
    // 지난 실행에서 드라이브 파일을 보내려고 임시로 받았다가 남은 것(nearby.ts sendDrive)
    if let Ok(dir) = app.path().app_cache_dir() {
        let _ = fs::remove_dir_all(dir.join("nearby"));
        let _ = fs::remove_dir_all(dir.join("nearby-in"));
    }
    app.manage(Arc::new(Nearby {
        id: random_id(),
        me: Mutex::new(None),
        daemon: Mutex::new(None),
        generation: AtomicU64::new(0),
        port: Mutex::new(None),
        identity: Mutex::new(None),
        active: AtomicUsize::new(0),
        peers: Default::default(),
        asks: Default::default(),
        conns: Default::default(),
        canceled: Default::default(),
        seq: AtomicU64::new(0),
    }));
}

/// 앱 종료: 근처 목록에서 바로 빠지도록 mDNS에 알리고 끝낸다
pub fn shutdown(app: &AppHandle) {
    if let Some(n) = app.try_state::<Arc<Nearby>>() {
        n.stop(app);
    }
}

impl Nearby {
    fn start(self: &Arc<Self>, app: &AppHandle, me: Me) -> Result<(), String> {
        if self.me.lock().unwrap().as_ref() == Some(&me) {
            return Ok(());
        }
        self.stop(app);
        let (port, identity) = self.listen(app)?;
        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        let instance = format!("udrive-{}", self.id);
        let version = VERSION.to_string();
        let props = [
            ("v", version.as_str()),
            ("fp", identity.fingerprint.as_str()),
            ("id", self.id.as_str()),
            ("name", me.person.name.as_str()),
            ("email", me.person.email.as_str()),
            ("device", me.person.device.as_str()),
            ("server", me.server.as_str()),
        ];
        let info = ServiceInfo::new(SERVICE, &instance, &format!("{instance}.local."), "", port, &props[..]).map_err(|e| e.to_string())?.enable_addr_auto();
        let fullname = info.get_fullname().to_string();
        daemon.register(info).map_err(|e| e.to_string())?;
        let events = daemon.browse(SERVICE).map_err(|e| e.to_string())?;
        let generation = self.generation.load(Ordering::SeqCst);
        let server = me.server.clone();
        *self.me.lock().unwrap() = Some(me);
        *self.daemon.lock().unwrap() = Some((daemon, fullname));
        let (n, app) = (self.clone(), app.clone());
        // daemon을 shutdown하면 events가 끊겨 스레드도 끝난다
        std::thread::spawn(move || {
            for ev in events {
                if n.generation.load(Ordering::SeqCst) != generation {
                    break;
                }
                n.on_event(&app, &server, ev);
            }
        });
        Ok(())
    }

    fn stop(&self, app: &AppHandle) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        *self.me.lock().unwrap() = None;
        let running = self.daemon.lock().unwrap().take();
        if let Some((daemon, fullname)) = running {
            // 상대 목록에서 바로 빠지도록 goodbye를 보내고 끝낸다
            if let Ok(rx) = daemon.unregister(&fullname) {
                let _ = rx.recv_timeout(Duration::from_secs(1));
            }
            let _ = daemon.shutdown();
        }
        self.peers.lock().unwrap().clear();
        self.emit_peers(app);
    }

    fn on_event(&self, app: &AppHandle, server: &str, ev: ServiceEvent) {
        match ev {
            ServiceEvent::ServiceResolved(s) => {
                let prop = |k: &str| s.get_property_val_str(k).unwrap_or_default().to_string();
                // 다른 버전(예전 평문 전송)은 서로 연결할 수 없으니 목록에 넣지 않는다
                if prop("id") == self.id || prop("server") != server || prop("v") != VERSION.to_string() || prop("fp").len() != 64 {
                    return;
                }
                let addrs: Vec<SocketAddr> = s.get_addresses().iter().map(|ip| ip.to_ip_addr()).filter(|ip| ip.is_ipv4()).map(|ip| SocketAddr::new(ip, s.get_port())).collect();
                if addrs.is_empty() {
                    return;
                }
                let peer = Peer { id: s.get_fullname().to_string(), person: Person { name: prop("name"), email: prop("email"), device: prop("device") }, addrs, fp: prop("fp") };
                self.peers.lock().unwrap().insert(peer.id.clone(), peer);
                self.emit_peers(app);
            }
            ServiceEvent::ServiceRemoved(_, fullname) => {
                if self.peers.lock().unwrap().remove(&fullname).is_some() {
                    self.emit_peers(app);
                }
            }
            _ => {}
        }
    }

    fn peer_list(&self) -> Vec<Peer> {
        let mut v: Vec<Peer> = self.peers.lock().unwrap().values().cloned().collect();
        v.sort_by(|a, b| (&a.person.name, &a.person.device).cmp(&(&b.person.name, &b.person.device)));
        v
    }

    fn emit_peers(&self, app: &AppHandle) {
        let _ = app.emit("nearby-peers", self.peer_list());
    }

    /// 받기용 TCP 포트와 인증서. 처음 start할 때 한 번 만든다
    fn listen(self: &Arc<Self>, app: &AppHandle) -> Result<(u16, Arc<tls::Identity>), String> {
        let mut port = self.port.lock().unwrap();
        let mut identity = self.identity.lock().unwrap();
        if let (Some(p), Some(id)) = (*port, identity.as_ref()) {
            return Ok((p, id.clone()));
        }
        let id = Arc::new(tls::Identity::new()?);
        let listener = TcpListener::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
        let p = listener.local_addr().map_err(|e| e.to_string())?.port();
        let (n, app) = (self.clone(), app.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                if n.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNS {
                    n.active.fetch_sub(1, Ordering::SeqCst);
                    continue; // drop하면 끊긴다
                }
                let (n, app) = (n.clone(), app.clone());
                std::thread::spawn(move || {
                    n.receive(&app, stream);
                    n.active.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        *port = Some(p);
        *identity = Some(id.clone());
        Ok((p, id))
    }

    fn next_id(&self, prefix: &str) -> String {
        format!("{prefix}{}", self.seq.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn receive(&self, app: &AppHandle, stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
        let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
        let Ok(ip) = stream.peer_addr().map(|a| a.ip()) else { return };
        // 암호화 전 소켓: 취소할 때 shutdown, 묻는 동안 끊겼는지 보기
        let Ok(raw) = stream.try_clone() else { return };
        let Some(identity) = self.identity.lock().unwrap().clone() else { return };
        let Ok(tls) = identity.accept(stream) else { return };
        let mut r = BufReader::new(tls);
        let Ok(header) = read_json::<Header>(&mut r) else { return };
        let me = self.me.lock().unwrap().clone();
        let files = match check_offer(&header, me.as_ref()) {
            Ok(f) => f,
            Err(reason) => return drop(write_json(r.get_mut(), &Reply::no(reason))),
        };
        let total = files.iter().map(|f| f.size).sum();
        let id = self.next_id("r");

        let (tx, rx) = mpsc::channel();
        let offer = Offer { id: id.clone(), from: header.from.clone(), files: files.clone(), total };
        {
            let mut asks = self.asks.lock().unwrap();
            if asks.len() >= MAX_ASKS || asks.values().any(|a| a.ip == ip) {
                drop(asks);
                return drop(write_json(r.get_mut(), &Reply::no("busy")));
            }
            asks.insert(id.clone(), Ask { tx, offer: offer.clone(), ip });
        }
        let _ = app.emit("nearby-offer", offer);
        open_popup(app);

        let answer = wait_answer(&rx, &raw, ASK_TIMEOUT);
        self.asks.lock().unwrap().remove(&id);
        let _ = app.emit("nearby-offer-closed", &id);
        self.close_popup_if_idle(app);
        let (target, pc_dir) = match answer {
            Some(Answer::Accept { target, pc_dir }) => (target, pc_dir),
            Some(Answer::Decline) => return drop(write_json(r.get_mut(), &Reply::no("declined"))),
            None => return drop(write_json(r.get_mut(), &Reply::no("timeout"))),
        };
        // 드라이브로 받기: 임시 폴더에 받고 메인 창이 올린다. 화면이 읽어 올릴 수 있는 크기(READ_CAP)를 넘는 파일은 PC 폴더에
        let drive = target.is_some();
        let pc = pc_dir.or_else(|| crate::download_dir(app));
        let temp = app.path().app_cache_dir().ok().map(|d| d.join("nearby-in").join(&id));
        let big = |f: &FileMeta| f.size > crate::localfs::READ_CAP;
        let Some(dirs) = files.iter().map(|f| if drive && !big(f) { temp.clone() } else { pc.clone() }).collect::<Option<Vec<PathBuf>>>() else {
            return drop(write_json(r.get_mut(), &Reply::no("disk")));
        };
        if write_json(r.get_mut(), &Reply { ok: true, ..Default::default() }).is_err() {
            return;
        }

        let mut t = Transfer { id: id.clone(), send: false, peer: header.from.name.clone(), name: files[0].name.clone(), count: files.len(), done: 0, total, status: "active", error: None, path: None, upload: vec![], note: None, target };
        t.emit(app);
        if let Ok(c) = raw.try_clone() {
            self.conns.lock().unwrap().insert(id.clone(), c);
        }
        let mut tick = Ticker::default();
        let result = recv_files(&mut r, &files, &dirs, |done| {
            if tick.due() {
                Transfer { done, ..t.clone() }.emit(app);
            }
        });
        self.conns.lock().unwrap().remove(&id);
        let canceled = self.canceled.lock().unwrap().remove(&id);
        match result {
            Ok(paths) => {
                let _ = write_json(r.get_mut(), &Reply { ok: true, done: true, ..Default::default() });
                t.done = total;
                t.status = "done";
                let in_temp = |p: &PathBuf| temp.as_ref().is_some_and(|d| p.starts_with(d));
                let (upload, local): (Vec<&PathBuf>, Vec<&PathBuf>) = paths.iter().partition(|p| in_temp(p));
                // PC에 받은 파일은 OS에 "다른 곳에서 온 파일"로 알린다. 드라이브로 올릴 임시 파일은 올린 뒤 지운다
                local.iter().for_each(|p| mark_from_network(p));
                t.upload = upload.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                t.path = local.first().map(|p| p.to_string_lossy().into_owned());
                if drive && !local.is_empty() {
                    t.note = Some(format!("200MB가 넘는 파일 {}개는 PC에 받았습니다", local.len()));
                }
            }
            Err(_) if canceled => t.status = "canceled",
            Err(e) => {
                t.status = "failed";
                t.error = Some(io_message(&e));
            }
        }
        // 못 받았으면 드라이브에 올릴 것도 없다
        if t.status != "done" {
            if let Some(d) = &temp {
                let _ = fs::remove_dir_all(d);
            }
        }
        t.emit(app);
    }

    fn send(&self, app: &AppHandle, id: String, peer: Peer, me: Me, files: Vec<(PathBuf, FileMeta)>, temp: bool) {
        let total = files.iter().map(|(_, f)| f.size).sum();
        let mut t = Transfer { id: id.clone(), send: true, peer: peer.person.name.clone(), name: files[0].1.name.clone(), count: files.len(), done: 0, total, status: "asking", error: None, path: None, upload: vec![], note: None, target: None };
        t.emit(app);
        let header = Header { v: VERSION, server: me.server, from: me.person, files: files.iter().map(|(_, f)| f.clone()).collect() };
        let mut tick = Ticker::default();
        let result = connect(&peer.addrs).and_then(|stream| {
            if let Ok(c) = stream.try_clone() {
                self.conns.lock().unwrap().insert(id.clone(), c);
            }
            let raw = stream.try_clone()?;
            raw.set_read_timeout(Some(IO_TIMEOUT))?;
            raw.set_write_timeout(Some(IO_TIMEOUT))?;
            let tls = tls::connect(stream, &peer.fp)?;
            send_over(tls, &raw, &header, &files, || Transfer { status: "active", ..t.clone() }.emit(app), |done| {
                if tick.due() {
                    Transfer { done, status: "active", ..t.clone() }.emit(app);
                }
            })
        });
        self.conns.lock().unwrap().remove(&id);
        let canceled = self.canceled.lock().unwrap().remove(&id);
        match result {
            Ok(()) => {
                t.done = total;
                t.status = "done";
            }
            Err(_) if canceled => t.status = "canceled",
            Err(SendError::Refused(reason)) => {
                t.status = if reason == "declined" || reason == "timeout" { "declined" } else { "failed" };
                t.error = Some(refused_message(&reason).into());
            }
            Err(SendError::Io(e)) => {
                t.status = "failed";
                t.error = Some(io_message(&e));
            }
        }
        t.emit(app);
        if temp {
            for (p, _) in &files {
                let _ = fs::remove_file(p);
                if let Some(dir) = p.parent() {
                    let _ = fs::remove_dir(dir); // 비었을 때만 지워진다
                }
            }
        }
    }

    /// 물어볼 게 없으면 팝업을 닫는다. 닫는 사이 새 요청이 들어왔으면 다시 띄운다.
    /// (창 만들기·닫기는 메인 스레드를 기다리므로 asks 잠금을 쥔 채 하지 않는다: 동기 커맨드가 메인 스레드에서 asks를 잠근다)
    fn close_popup_if_idle(&self, app: &AppHandle) {
        if !self.asks.lock().unwrap().is_empty() {
            return;
        }
        if let Some(w) = app.get_webview_window(POPUP) {
            let _ = w.destroy();
        }
        if !self.asks.lock().unwrap().is_empty() {
            open_popup(app);
        }
    }

    fn offer_list(&self) -> Vec<Offer> {
        let mut v: Vec<Offer> = self.asks.lock().unwrap().values().map(|a| a.offer.clone()).collect();
        v.sort_by_key(|o| o.id[1..].parse::<u64>().unwrap_or_default());
        v
    }

    fn cancel(&self, id: &str) {
        if let Some(a) = self.asks.lock().unwrap().get(id) {
            let _ = a.tx.send(Answer::Decline);
            return;
        }
        if let Some(c) = self.conns.lock().unwrap().get(id) {
            self.canceled.lock().unwrap().insert(id.to_string());
            let _ = c.shutdown(Shutdown::Both);
        }
    }
}

/// 받기 요청 팝업을 화면 오른쪽 아래에 띄운다. 포커스를 가져가지 않아 일하던 창에서 계속 입력할 수 있다.
/// 이미 떠 있으면 그대로 둔다(팝업이 nearby-offer 이벤트로 새 요청을 받는다)
fn open_popup(app: &AppHandle) {
    if app.get_webview_window(POPUP).is_some() {
        return;
    }
    let (w, h) = POPUP_SIZE;
    let mut b = WebviewWindowBuilder::new(app, POPUP, WebviewUrl::default())
        .title("파일 수신")
        .inner_size(w, h)
        .resizable(false)
        .decorations(false)
        .shadow(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false);
    // 맥: 비활성 앱의 창이라도 첫 클릭이 바로 버튼에 닿게. 창을 투명하게 두고 화면이 둥근 상자를 그린다(불투명 창은 각진 사각형)
    #[cfg(target_os = "macos")]
    {
        b = b.accept_first_mouse(true).transparent(true);
    }
    // 마우스가 있는 화면(못 찾으면 주 화면)의 작업 영역 오른쪽 아래
    let monitor = app.cursor_position().ok().and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten()).or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let (s, a) = (m.scale_factor(), m.work_area());
        let x = (a.position.x as f64 + a.size.width as f64) / s - w - 16.0;
        let y = (a.position.y as f64 + a.size.height as f64) / s - h - 16.0;
        b = b.position(x, y);
    }
    if let Err(e) = b.build() {
        eprintln!("nearby popup: {e}");
    }
}

/// 받은 헤더를 확인하고, 저장해도 안전한 이름으로 바꾼 파일 목록. Err는 거절 사유(상대에게 그대로 보낸다)
fn check_offer(h: &Header, me: Option<&Me>) -> Result<Vec<FileMeta>, &'static str> {
    let me = me.ok_or("off")?;
    if h.v != VERSION {
        return Err("version");
    }
    if h.server != me.server {
        return Err("server");
    }
    if h.files.is_empty() || h.files.len() > 10_000 {
        return Err("name");
    }
    h.files.iter().map(|f| Ok(FileMeta { name: safe_name(&f.name).ok_or("name")?, size: f.size })).collect::<Result<_, _>>()
}

/// 화면에 안 보이거나 글자 방향을 바꾸는 문자. 이름에 끼면 "보고서\u{202E}fdp.exe"가 "보고서exe.pdf"로 보인다
fn is_invisible(c: char) -> bool {
    matches!(c, '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}')
}

/// 상대가 준 이름에서 경로를 떼고 OS가 못 쓰는 글자를 바꾸고 안 보이는 문자를 지운다. 쓸 수 없는 이름이면 None
fn safe_name(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|&c| !is_invisible(c)).map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c }).collect();
    // 윈도우는 끝의 점·공백을 지운다
    let cleaned = cleaned.trim().trim_end_matches('.').to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return None;
    }
    Some(cleaned)
}

/// dir 안에 name과 겹치지 않는 새 파일을 만든다. 있으면 "이름 (1).확장자" 식으로 번호를 붙인다
fn create_free(dir: &Path, name: &str) -> io::Result<(File, PathBuf)> {
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for n in 0.. {
        let path = if n == 0 { dir.join(name) } else { dir.join(format!("{stem} ({n}){ext}")) };
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(f) => return Ok((f, path)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

/// 받은 파일에 "다른 곳에서 온 파일" 표시를 붙인다(브라우저·메신저로 받은 파일과 같게). 실패해도 받기는 그대로.
/// 맥은 quarantine 확장 속성이라 앱·스크립트를 열 때 Gatekeeper가 검사하고,
/// 윈도우는 Zone.Identifier(ZoneId=3, 인터넷)라 SmartScreen·Office 제한된 보기가 적용된다
fn mark_from_network(path: &Path) {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(p) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return };
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default();
        let value = format!("0081;{secs:08x};U-Drive;");
        // SAFETY: p·이름은 NUL로 끝나는 C 문자열이고, value는 길이와 함께 넘긴다
        unsafe {
            libc::setxattr(p.as_ptr(), c"com.apple.quarantine".as_ptr(), value.as_ptr().cast(), value.len(), 0, 0);
        }
    }
    #[cfg(windows)]
    {
        let mut ads = path.as_os_str().to_owned();
        ads.push(":Zone.Identifier");
        let _ = fs::write(ads, "[ZoneTransfer]\r\nZoneId=3\r\n");
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = path;
}

/// 파일 목록 순서대로 이어 온 바이트를 저장한다(files[i]는 dirs[i]에). 실패하면 받던 파일만 지우고, 다 받은 파일은 남긴다
fn recv_files(r: &mut impl Read, files: &[FileMeta], dirs: &[PathBuf], mut progress: impl FnMut(u64)) -> io::Result<Vec<PathBuf>> {
    let mut saved = Vec::new();
    let mut got = 0;
    for (f, dir) in files.iter().zip(dirs) {
        fs::create_dir_all(dir)?;
        let (mut out, path) = create_free(dir, &f.name)?;
        let res = copy_exact(r, &mut out, f.size, |n| {
            got += n;
            progress(got);
        });
        if let Err(e) = res.and_then(|_| out.flush()) {
            drop(out);
            let _ = fs::remove_file(&path);
            return Err(e);
        }
        saved.push(path);
    }
    Ok(saved)
}

/// 정확히 size 바이트를 옮긴다. 상대가 먼저 끊으면 UnexpectedEof
fn copy_exact(r: &mut impl Read, w: &mut impl Write, size: u64, mut progress: impl FnMut(u64)) -> io::Result<()> {
    let mut buf = vec![0u8; 256 * 1024];
    let mut left = size;
    while left > 0 {
        let want = left.min(buf.len() as u64) as usize;
        let n = r.read(&mut buf[..want])?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        w.write_all(&buf[..n])?;
        left -= n as u64;
        progress(n as u64);
    }
    Ok(())
}

#[derive(Debug)]
enum SendError {
    /// 상대가 거절했다(사유)
    Refused(String),
    Io(io::Error),
}

impl From<io::Error> for SendError {
    fn from(e: io::Error) -> Self {
        SendError::Io(e)
    }
}

fn connect(addrs: &[SocketAddr]) -> Result<TcpStream, SendError> {
    let mut last = io::Error::new(io::ErrorKind::NotFound, "주소 없음");
    for a in addrs {
        match TcpStream::connect_timeout(a, Duration::from_secs(3)) {
            Ok(s) => return Ok(s),
            Err(e) => last = e,
        }
    }
    Err(last.into())
}

/// 헤더를 보내고 상대 답을 기다린 뒤 파일을 보낸다. on_accept는 상대가 받기로 했을 때 한 번.
/// stream은 TLS로 감싼 연결, raw는 그 아래 소켓(시간 제한을 바꾸는 데만 쓴다)
fn send_over(stream: impl Read + Write, raw: &TcpStream, header: &Header, files: &[(PathBuf, FileMeta)], on_accept: impl FnOnce(), mut progress: impl FnMut(u64)) -> Result<(), SendError> {
    let mut r = BufReader::new(stream);
    write_json(r.get_mut(), header)?;
    // 상대가 묻는 동안은 기다린다. 시간 초과는 받는 쪽이 답으로 알려준다
    raw.set_read_timeout(Some(ASK_TIMEOUT + IO_TIMEOUT))?;
    let reply: Reply = read_json(&mut r)?;
    if !reply.ok {
        return Err(SendError::Refused(reply.reason.unwrap_or_default()));
    }
    on_accept();
    raw.set_read_timeout(Some(IO_TIMEOUT))?;
    raw.set_write_timeout(Some(IO_TIMEOUT))?;
    let mut sent = 0;
    for (path, f) in files {
        let mut src = File::open(path)?;
        copy_exact(&mut src, r.get_mut(), f.size, |n| {
            sent += n;
            progress(sent);
        })?;
    }
    r.get_mut().flush()?;
    let done: Reply = read_json(&mut r)?;
    if !done.done {
        return Err(SendError::Refused(done.reason.unwrap_or_default()));
    }
    Ok(())
}

/// 답이 오거나, 시간이 지나거나(None), 보낸 쪽이 연결을 끊을 때(None)까지 기다린다
fn wait_answer(rx: &mpsc::Receiver<Answer>, stream: &TcpStream, timeout: Duration) -> Option<Answer> {
    let deadline = Instant::now() + timeout;
    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(a) => return Some(a),
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
            Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() >= deadline || peer_closed(stream) => return None,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

/// 보낸 쪽은 답을 기다리는 동안 아무것도 보내지 않는다. TLS 아래 소켓에 무엇이든 오면(EOF, 종료 알림) 끊은 것
fn peer_closed(stream: &TcpStream) -> bool {
    if stream.set_nonblocking(true).is_err() {
        return false;
    }
    let r = stream.peek(&mut [0u8; 1]);
    let _ = stream.set_nonblocking(false);
    match r {
        Ok(_) => true,
        Err(e) => e.kind() != io::ErrorKind::WouldBlock,
    }
}

pub(crate) fn read_json<T: DeserializeOwned>(r: &mut impl BufRead) -> io::Result<T> {
    let mut line = String::new();
    r.take(MAX_LINE).read_line(&mut line)?;
    if !line.ends_with('\n') {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    serde_json::from_str(&line).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

fn write_json(w: &mut impl Write, v: &impl Serialize) -> io::Result<()> {
    let mut s = serde_json::to_string(v).map_err(io::Error::other)?;
    s.push('\n');
    w.write_all(s.as_bytes())?;
    w.flush()
}

fn refused_message(reason: &str) -> &'static str {
    match reason {
        "declined" => "상대가 거절했습니다",
        "timeout" => "상대가 응답하지 않았습니다",
        "server" => "다른 서버에 로그인한 사용자입니다",
        "off" => "상대가 바로 보내기를 끄고 있습니다",
        "version" => "상대 U-Drive 버전이 맞지 않습니다. 둘 다 업데이트해 주세요",
        "disk" => "상대 PC에 저장할 폴더가 없습니다",
        "busy" => "상대가 다른 받기 요청에 답하는 중입니다. 잠시 뒤 다시 보내 주세요",
        _ => "전송이 중단됐습니다",
    }
}

fn io_message(e: &io::Error) -> String {
    match e.kind() {
        io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted | io::ErrorKind::BrokenPipe => "연결이 끊겼습니다".into(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => "응답이 없어 중단했습니다".into(),
        io::ErrorKind::ConnectionRefused => "상대에게 연결할 수 없습니다".into(),
        io::ErrorKind::NotFound => "파일을 찾을 수 없습니다".into(),
        // TLS 실패: 인증서 지문이 다름(다른 PC가 주소를 가로챘거나 상대가 다시 시작함) 등
        io::ErrorKind::InvalidData => "상대 기기를 확인하지 못해 보내지 않았습니다. 목록을 새로 고친 뒤 다시 보내 주세요".into(),
        _ => e.to_string(),
    }
}

/// 진행 이벤트는 100ms에 한 번만
#[derive(Default)]
struct Ticker(Option<Instant>);

impl Ticker {
    fn due(&mut self) -> bool {
        let now = Instant::now();
        if self.0.is_some_and(|t| now.duration_since(t) < Duration::from_millis(100)) {
            return false;
        }
        self.0 = Some(now);
        true
    }
}

fn random_id() -> String {
    use ring::rand::SecureRandom;
    let mut b = [0u8; 8];
    let _ = ring::rand::SystemRandom::new().fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 받는 사람 목록에 보일 PC 이름. 맥은 "…MacBook-Pro.local"처럼 오므로 .local을 뗀다
pub(crate) fn device_name() -> String {
    let h = gethostname::gethostname().to_string_lossy().into_owned();
    h.strip_suffix(".local").unwrap_or(&h).to_string()
}

/// 로그인했을 때(그리고 설정에서 켜 둔 동안) 근처에 나를 알리고 다른 U-Drive를 찾는다. server는 Seafile 주소
#[tauri::command]
pub fn nearby_start(app: AppHandle, state: State<Arc<Nearby>>, name: String, email: String, server: String) -> Result<(), String> {
    let server = server.trim().trim_end_matches('/').to_lowercase();
    state.inner().start(&app, Me { person: Person { name, email, device: device_name() }, server })
}

#[tauri::command]
pub fn nearby_stop(app: AppHandle, state: State<Arc<Nearby>>) {
    state.stop(&app);
}

#[tauri::command]
pub fn nearby_peers(state: State<Arc<Nearby>>) -> Vec<Peer> {
    state.peer_list()
}

#[derive(Deserialize)]
pub struct SendFile {
    path: String,
    name: String,
}

/// 파일을 보낸다. 진행은 nearby-transfer 이벤트로. temp면 끝난 뒤 파일을 지운다(드라이브에서 임시로 받은 파일)
#[tauri::command]
pub fn nearby_send(app: AppHandle, state: State<Arc<Nearby>>, peer: String, files: Vec<SendFile>, temp: bool) -> Result<String, String> {
    let me = state.me.lock().unwrap().clone().ok_or("바로 보내기가 꺼져 있습니다")?;
    let peer = state.peers.lock().unwrap().get(&peer).cloned().ok_or("상대가 목록에서 사라졌습니다")?;
    if files.is_empty() {
        return Err("보낼 파일이 없습니다".into());
    }
    let files = files
        .into_iter()
        .map(|f| {
            let size = fs::metadata(&f.path).map_err(|e| format!("{}: {}", f.name, io_message(&e)))?.len();
            Ok((PathBuf::from(f.path), FileMeta { name: f.name, size }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let n = state.inner().clone();
    let id = n.next_id("s");
    let ret = id.clone();
    std::thread::spawn(move || n.send(&app, id, peer, me, files, temp));
    Ok(ret)
}

/// 팝업이 처음 뜰 때 이미 와 있는 받기 요청(이벤트보다 늦게 뜰 수 있어서)
#[tauri::command]
pub fn nearby_offers(state: State<Arc<Nearby>>) -> Vec<Offer> {
    state.offer_list()
}

/// 받기 요청에 답한다. target(드라이브 폴더)이 있으면 드라이브로 받기: 임시로 받아 메인 창이 그 폴더에 올린다.
/// pc_dir은 PC에 받을 폴더(설정에서 고른 곳). 없으면 다운로드 폴더
#[tauri::command]
pub fn nearby_answer(state: State<Arc<Nearby>>, id: String, accept: bool, target: Option<serde_json::Value>, pc_dir: Option<String>) {
    if let Some(a) = state.asks.lock().unwrap().get(&id) {
        let _ = a.tx.send(if accept { Answer::Accept { target, pc_dir: pc_dir.map(PathBuf::from) } } else { Answer::Decline });
    }
}

/// 드라이브로 받은 임시 파일을 다 올렸다(또는 포기했다): 지운다
#[tauri::command]
pub fn nearby_cleanup(app: AppHandle, id: String) {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return;
    }
    if let Ok(dir) = app.path().app_cache_dir() {
        let _ = fs::remove_dir_all(dir.join("nearby-in").join(id));
    }
}

/// 팝업의 "폴더 바꾸기": 메인 창을 띄워 설정의 바로 보내기 페이지를 연다
#[tauri::command]
pub fn nearby_open_settings(app: AppHandle) {
    crate::show_main(&app);
    let _ = app.emit("tray", "send-settings");
}

#[tauri::command]
pub fn nearby_cancel(state: State<Arc<Nearby>>, id: String) {
    state.cancel(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("udrive-nearby-{name}-{}", random_id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn me(server: &str) -> Me {
        Me { person: Person { name: "나".into(), email: "me@x.com".into(), device: "PC".into() }, server: server.into() }
    }

    fn header(server: &str, names: &[&str]) -> Header {
        Header { v: VERSION, server: server.into(), from: me(server).person, files: names.iter().map(|n| FileMeta { name: n.to_string(), size: 1 }).collect() }
    }

    #[test]
    fn safe_name_strips_paths_and_bad_chars() {
        assert_eq!(safe_name("a.pdf").as_deref(), Some("a.pdf"));
        assert_eq!(safe_name("../../etc/passwd").as_deref(), Some("passwd"));
        assert_eq!(safe_name("..\\..\\win.ini").as_deref(), Some("win.ini"));
        assert_eq!(safe_name("a:b?.txt").as_deref(), Some("a_b_.txt"));
        assert_eq!(safe_name("보고서.hwp ").as_deref(), Some("보고서.hwp"));
        assert_eq!(safe_name("보고서\u{202E}fdp.exe").as_deref(), Some("보고서fdp.exe"));
        assert_eq!(safe_name("a\u{200B}b\u{2066}.txt\u{FEFF}").as_deref(), Some("ab.txt"));
        assert_eq!(safe_name("\u{202E}"), None);
        assert_eq!(safe_name("dir/"), None);
        assert_eq!(safe_name(".."), None);
        assert_eq!(safe_name(""), None);
    }

    #[test]
    fn check_offer_rejects_other_server_and_bad_names() {
        let m = me("https://a");
        assert_eq!(check_offer(&header("https://a", &["x"]), None).unwrap_err(), "off");
        assert_eq!(check_offer(&header("https://b", &["x"]), Some(&m)).unwrap_err(), "server");
        assert_eq!(check_offer(&header("https://a", &[".."]), Some(&m)).unwrap_err(), "name");
        assert_eq!(check_offer(&header("https://a", &[]), Some(&m)).unwrap_err(), "name");
        assert_eq!(check_offer(&header("https://a", &["../x.txt"]), Some(&m)).unwrap()[0].name, "x.txt");
    }

    #[test]
    fn create_free_numbers_duplicates() {
        let d = tmp("free");
        let (_, a) = create_free(&d, "a.txt").unwrap();
        let (_, b) = create_free(&d, "a.txt").unwrap();
        let (_, c) = create_free(&d, "a.txt").unwrap();
        assert_eq!(a.file_name().unwrap(), "a.txt");
        assert_eq!(b.file_name().unwrap(), "a (1).txt");
        assert_eq!(c.file_name().unwrap(), "a (2).txt");
        fs::remove_dir_all(d).unwrap();
    }

    /// 받는 쪽 흉내(TLS): 헤더를 읽고 answer대로 답한 뒤, 받으면 저장하고 done을 보낸다. 인증서 지문도 돌려준다
    fn fake_receiver(answer: Option<&'static str>, dir: PathBuf) -> (SocketAddr, String, std::thread::JoinHandle<Vec<PathBuf>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let id = tls::Identity::new().unwrap();
        let fp = id.fingerprint.clone();
        let h = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut r = BufReader::new(id.accept(s).unwrap());
            let h: Header = read_json(&mut r).unwrap();
            let files = check_offer(&h, Some(&me("https://a"))).unwrap();
            if let Some(reason) = answer {
                write_json(r.get_mut(), &Reply::no(reason)).unwrap();
                return vec![];
            }
            write_json(r.get_mut(), &Reply { ok: true, ..Default::default() }).unwrap();
            let dirs = vec![dir.clone(); files.len()];
            let saved = recv_files(&mut r, &files, &dirs, |_| {}).unwrap();
            write_json(r.get_mut(), &Reply { ok: true, done: true, ..Default::default() }).unwrap();
            saved
        });
        (addr, fp, h)
    }

    /// 보내는 쪽 연결: TCP를 열고 지문을 확인해 TLS로 감싼다. 아래 소켓도 돌려준다
    fn open(addr: SocketAddr, fp: &str) -> (rustls::StreamOwned<rustls::ClientConnection, TcpStream>, TcpStream) {
        let s = connect(&[addr]).unwrap();
        let raw = s.try_clone().unwrap();
        (tls::connect(s, fp).unwrap(), raw)
    }

    #[test]
    fn sends_files_over_tcp() {
        let src = tmp("src");
        let dst = tmp("dst");
        let big: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(src.join("big.bin"), &big).unwrap();
        fs::write(src.join("빈 파일.txt"), b"").unwrap();
        fs::write(dst.join("big.bin"), b"old").unwrap(); // 이미 있으면 번호를 붙여 저장
        let files = vec![
            (src.join("big.bin"), FileMeta { name: "big.bin".into(), size: big.len() as u64 }),
            (src.join("빈 파일.txt"), FileMeta { name: "빈 파일.txt".into(), size: 0 }),
        ];
        let (addr, fp, h) = fake_receiver(None, dst.clone());
        let (stream, raw) = open(addr, &fp);
        let mut accepted = false;
        let mut last = 0;
        send_over(stream, &raw, &Header { v: VERSION, server: "https://a".into(), from: me("https://a").person, files: files.iter().map(|f| f.1.clone()).collect() }, &files, || accepted = true, |n| last = n).unwrap();
        let saved = h.join().unwrap();
        assert!(accepted);
        assert_eq!(last, big.len() as u64);
        assert_eq!(saved[0].file_name().unwrap(), "big (1).bin");
        assert_eq!(fs::read(&saved[0]).unwrap(), big);
        assert_eq!(fs::read(&saved[1]).unwrap(), b"");
        assert_eq!(fs::read(dst.join("big.bin")).unwrap(), b"old");
        fs::remove_dir_all(src).unwrap();
        fs::remove_dir_all(dst).unwrap();
    }

    #[test]
    fn declined_offer_sends_nothing() {
        let src = tmp("src2");
        fs::write(src.join("a.txt"), b"hi").unwrap();
        let files = vec![(src.join("a.txt"), FileMeta { name: "a.txt".into(), size: 2 })];
        let (addr, fp, h) = fake_receiver(Some("declined"), src.clone());
        let mut accepted = false;
        let (stream, raw) = open(addr, &fp);
        let err = send_over(stream, &raw, &Header { v: VERSION, server: "https://a".into(), from: me("https://a").person, files: vec![files[0].1.clone()] }, &files, || accepted = true, |_| {}).unwrap_err();
        h.join().unwrap();
        assert!(!accepted);
        assert!(matches!(err, SendError::Refused(r) if r == "declined"));
        fs::remove_dir_all(src).unwrap();
    }

    #[test]
    fn receiver_drops_partial_file_when_sender_disconnects() {
        let dst = tmp("partial");
        let files = vec![FileMeta { name: "a.txt".into(), size: 1 }, FileMeta { name: "b.txt".into(), size: 10 }];
        let mut r: &[u8] = b"Abcd"; // b.txt는 3바이트만 오고 끊김
        let err = recv_files(&mut r, &files, &[dst.clone(), dst.clone()], |_| {}).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
        assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"A");
        assert!(!dst.join("b.txt").exists());
        fs::remove_dir_all(dst).unwrap();
    }

    /// 드라이브로 받기: 작은 파일은 임시 폴더, 큰 파일은 PC 폴더처럼 파일마다 다른 곳에 저장한다
    #[test]
    fn recv_files_saves_each_file_to_its_dir() {
        let (temp, pc) = (tmp("temp"), tmp("pc"));
        let files = vec![FileMeta { name: "작은.txt".into(), size: 2 }, FileMeta { name: "큰.bin".into(), size: 3 }];
        let mut r: &[u8] = b"hiBIG";
        let saved = recv_files(&mut r, &files, &[temp.clone(), pc.clone()], |_| {}).unwrap();
        assert_eq!(saved, vec![temp.join("작은.txt"), pc.join("큰.bin")]);
        assert_eq!(fs::read(&saved[1]).unwrap(), b"BIG");
        fs::remove_dir_all(temp).unwrap();
        fs::remove_dir_all(pc).unwrap();
    }

    #[test]
    fn busy_reason_has_message() {
        assert_ne!(refused_message("busy"), refused_message("unknown"));
    }

    /// 받은 파일에 quarantine 확장 속성이 붙는다(맥)
    #[cfg(target_os = "macos")]
    #[test]
    fn marks_received_file_quarantined() {
        let d = tmp("quarantine");
        let p = d.join("받은 파일.pdf");
        fs::write(&p, b"x").unwrap();
        mark_from_network(&p);
        let out = std::process::Command::new("xattr").arg("-p").arg("com.apple.quarantine").arg(&p).output().unwrap();
        let v = String::from_utf8_lossy(&out.stdout);
        assert!(v.starts_with("0081;") && v.contains(";U-Drive;"), "{v:?}");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn peer_closed_detects_eof() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let c = TcpStream::connect(l.local_addr().unwrap()).unwrap();
        let (s, _) = l.accept().unwrap();
        assert!(!peer_closed(&s));
        drop(c);
        std::thread::sleep(Duration::from_millis(50));
        assert!(peer_closed(&s));
    }

    /// 실제 네트워크로 mDNS 등록·탐색. 같은 PC의 두 데몬이 서로 찾는지 본다: cargo test -- --ignored mdns
    #[test]
    #[ignore]
    fn mdns_finds_registered_service() {
        let a = ServiceDaemon::new().unwrap();
        let props = [("id", "test-a"), ("name", "가"), ("server", "https://a")];
        let info = ServiceInfo::new(SERVICE, "udrive-test-a", "udrive-test-a.local.", "", 4321, &props[..]).unwrap().enable_addr_auto();
        a.register(info).unwrap();
        let b = ServiceDaemon::new().unwrap();
        let events = b.browse(SERVICE).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let found = loop {
            match events.recv_timeout(Duration::from_millis(200)) {
                Ok(ServiceEvent::ServiceResolved(s)) if s.get_property_val_str("id") == Some("test-a") => break Some(s),
                _ if Instant::now() > deadline => break None,
                _ => {}
            }
        };
        let s = found.expect("10초 안에 찾지 못함");
        assert_eq!(s.get_port(), 4321);
        assert_eq!(s.get_property_val_str("name"), Some("가"));
        assert!(s.get_addresses().iter().any(|ip| ip.to_ip_addr().is_ipv4()));
        let _ = a.shutdown();
        let _ = b.shutdown();
    }
}
