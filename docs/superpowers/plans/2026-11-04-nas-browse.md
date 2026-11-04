# 디자인나스(공용 NAS 하드) 탐색 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seafile 서버 PC의 Drive 앱이 연결된 하드 폴더를 "NAS로 열기"로 열어 두면, 같은 사무실 네트워크의 디자이너 Drive 앱 사이드바에 "디자인나스"가 떠서 탐색·이름 검색·내려받기를 할 수 있게 한다.

**Architecture:** 서버 PC 앱(제공 쪽)은 Rust가 하드를 읽고, TLS로 요청 네 가지(info·list·index·read)를 받고, mDNS로 자신을 알린다. 요청에는 로그인 정보를 싣지 않는다(사용자 결정: 토큰을 다른 기기에 보내지 않는다). 디자이너 앱(받는 쪽)은 Rust가 mDNS로 제공 쪽을 찾고 요청을 보내며, JS는 기존 `StorageProvider`를 감싸는 `withNas`로 NAS를 읽기 전용 라이브러리 하나처럼 보이게 한다.

**Tech Stack:** Tauri 2 (Rust), `mdns-sd`·`rustls`(바로 보내기에서 쓰는 것)·`notify-debouncer-mini`(폴더 동기화에서 쓰는 것) — 새 의존성 없음. React 19, TanStack Query, Vitest.

**Spec:** [docs/superpowers/specs/2026-11-03-nas-browse-design.md](../specs/2026-11-03-nas-browse-design.md)

## Global Constraints

- 하드는 **읽기만** 한다. 쓰기·삭제·이동 금지. 디자이너 쪽은 업로드·이름 변경·삭제·공유·휴지통·미리보기·썸네일 없음(내려받기만).
- 제공 쪽은 고른 하드 폴더(이하 루트) 밖을 절대 읽지 않는다(`..`, 절대 경로, 링크·정션으로 빠져나가기 금지).
- **인증 없음 (사용자 결정, Task 3 뒤)**: 사무실 네트워크 안의 Drive 앱이면 누구나 읽기 전용으로 본다. 받는 쪽은 Seafile 토큰을 어떤 기기에도 보내지 않는다. 이유: 같은 네트워크의 아무 기기나 `_udrive-nas`를 알리면 토큰이 그 기기로 새기 때문. 받는 쪽은 자기 Seafile 서버와 같은 `server`를 알린 제공 쪽만 목록에 넣는다.
- 사이드바 이름은 제공 쪽이 로그인한 계정 이름(`getAccount().name`, 예: "디자인나스"), 섹션 이름은 `"NAS"`.
- 목록·색인에서 뺄 이름: `.`으로 시작, `$RECYCLE.BIN`, `System Volume Information`, `Thumbs.db`, `desktop.ini`, `~$`로 시작(대소문자 무시).
- 색인 다시 만들기: 열 때, 변경 감시 60초 디바운스 후, 24시간마다.
- mDNS 서비스 `_udrive-nas._tcp.local.`, 속성 `v=1`, `fp`(인증서 지문 64자), `name`, `server`(Seafile 주소). 받는 쪽은 `server`가 자기 서버와 같고 `v=1`인 것만 쓴다.
- 데스크톱 앱 전용: 웹(`!isTauri()`)에서는 NAS 메뉴·라이브러리·엔진을 모두 숨긴다.
- 새 Tauri 커맨드는 `src-tauri/build.rs`의 `COMMANDS`와 `src-tauri/capabilities/default.json`의 `allow-…`에 **둘 다** 넣는다.
- 파일 줄끝 CRLF(`git ls-files --eol`로 확인). `npx prettier --write` 금지. 사용자 문구는 한국어.

## Review Focus

1. **루트 밖 경로**(`/../Windows`, `/a/../../x`, `C:\Windows`, 루트 안의 정션이 밖을 가리킴): 거절해야 한다 → Task 1 `resolve_in_rejects_escape`.
2. **받는 쪽이 토큰을 보내지 않음**: 요청 어디에도 Seafile 토큰이 없어야 한다 → Task 3b `request_has_no_token`.
3. **제공 쪽 앱이 꺼짐·연결 끊김**: 디자이너 화면에 "디자인나스에 연결할 수 없습니다. 서버 PC의 Drive 앱이 켜져 있는지 확인하세요"가 나와야 한다 → Task 4 `list error becomes network StorageError`.
4. **내려받는 중 연결이 끊김**: 반쯤 받은 파일이 남지 않아야 한다 → Task 3 `download_removes_partial_file`.
5. **파일 수십만 개**: 검색 색인을 매번 다시 받지 않아야 한다(색인 버전이 같으면 캐시) → Task 4 `listLibraries uses index version as headCommitId`.

---

## 파일 구조

```
src-tauri/src/nasfs.rs        # 새: 루트 안 경로 확인·목록·색인 만들기·제외 규칙 (fs만, 테스트)
src-tauri/src/nas.rs          # 새: 프로토콜, 제공 쪽 서버·mDNS 알림·색인 갱신, 받는 쪽 찾기·요청·내려받기
src/storage/nas/native.ts     # 새: Rust 커맨드·이벤트 래퍼, 피어 목록 보관
src/storage/nas/withNas.ts    # 새 (+ .test.ts): StorageProvider 감싸기
src/features/nas/NasRoot.tsx      # 새: 받는 쪽 찾기 시작, 피어 바뀌면 라이브러리 다시 읽기
src/features/nas/NasHostRoot.tsx  # 새: 제공 쪽 자동 열기, 토큰 확인 응답
src/features/settings/NasPage.tsx # 새: 설정 → NAS로 열기
src/features/settings/keepAppOn.ts # 새: 자동 실행·트레이·자동 로그인 확인/켜기(동기화와 공유)
```

---

### Task 1: Rust `nasfs` — 루트 안 경로·목록·색인

**Files:**
- Create: `src-tauri/src/nasfs.rs`
- Modify: `src-tauri/src/lib.rs` (`mod nasfs;`), `src-tauri/src/localfs.rs` (`read_range`를 `pub(crate)`로)

**Interfaces:**
- Produces:
  - `#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)] #[serde(rename_all = "camelCase")] pub struct NasEntry { pub name: String, #[serde(rename = "type")] pub kind: String /* "file"|"dir" */, pub size: u64, pub mtime: f64 /* 유닉스 초 */, pub path: String /* "/a/b.psd", 루트 기준 */ }`
  - `pub fn resolve_in(root: &Path, rel: &str) -> Result<PathBuf, String>` — `rel`은 `/`로 시작. 실패 문구 `"허용되지 않는 경로입니다"`.
  - `pub fn list(root: &Path, rel: &str) -> Result<Vec<NasEntry>, String>` — 한 단계, 제외 규칙 적용, 폴더 먼저·이름순.
  - `pub fn build_index(root: &Path, progress: impl FnMut(usize)) -> Vec<NasEntry>` — 재귀, 링크된 폴더는 따라가지 않음, 제외된 폴더는 하위 전체 건너뜀, 1000개마다 `progress(지금까지 개수)`.
  - `pub(crate) fn read_range(path: &Path, start: u64, len: u64) -> Result<Vec<u8>, String>` (localfs, 기존)

- [ ] **Step 1: 실패하는 테스트 작성** (`nasfs.rs`의 `#[cfg(test)] mod tests`, `localfs.rs` 테스트의 `temp_dir` 방식)

```rust
#[test] fn resolve_in_rejects_escape() {
    let root = temp_dir("nas-root");
    std::fs::create_dir_all(root.join("a")).unwrap();
    assert!(resolve_in(&root, "/a").is_ok());
    for bad in ["/../x", "/a/../../x", "a", "C:\\Windows", "/a\\..\\..\\x"] { assert!(resolve_in(&root, bad).is_err(), "{bad}"); }
}
#[cfg(unix)] #[test] fn resolve_in_rejects_link_out_of_root() { /* root/out -> 바깥 폴더 symlink, resolve_in(&root,"/out") is_err */ }
#[test] fn list_sorts_dirs_first_and_skips_excluded() {
    // root/{사진/, b.psd, a.ai, .DS_Store, ~$x.docx, Thumbs.db, $RECYCLE.BIN/}
    // list(&root,"/") 의 (kind,name) == [("dir","사진"),("file","a.ai"),("file","b.psd")], path == "/사진" 등
}
#[test] fn build_index_walks_tree_and_skips_excluded_dirs() {
    // root/사진/2020/x.jpg, root/.git/y, root/z.txt → path 집합 == {"/사진","/사진/2020","/사진/2020/x.jpg","/z.txt"}
}
```

- [ ] **Step 2: 실패 확인** — Run: `cd src-tauri && cargo test --lib nasfs` → 컴파일 실패(함수 없음)
- [ ] **Step 3: 구현** — `resolve_in`: `rel`이 `/`로 시작하지 않거나 `\`가 있거나 `..` 조각이 있으면 거절 → `root.join(rel 앞 '/' 제거)` → `canonicalize` 결과가 `canonicalize(root)`로 시작하지 않으면 거절(정션·링크 탈출 차단). 제외 판정은 `fn excluded(name: &str) -> bool` 하나로 `list`·`build_index`가 공유.
- [ ] **Step 4: 통과 확인** — 같은 명령 → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(nas): 루트 안 경로 확인·목록·색인 만들기"`

---

### Task 2: Rust `nas` — 프로토콜과 제공 쪽 서버

**Files:**
- Create: `src-tauri/src/nas.rs`
- Modify: `src-tauri/src/lib.rs` (`mod nas;`, `nas::setup(app)` in `setup`, 종료 시 `nas::shutdown`, invoke_handler), `src-tauri/build.rs`, `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: Task 1 전부, `tls::Identity::new()`, `Identity::accept`, `identity.fingerprint`
- Produces:
  - 요청(한 줄 JSON + `\n`): `#[derive(Serialize, Deserialize)] struct Req { v: u32 /*1*/, token: String, op: String /*"info"|"list"|"index"|"read"*/, path: Option<String>, start: Option<u64> }`
  - 응답: 한 줄 JSON. 실패 `{"ok":false,"error":"..."}`. `info` → `{"ok":true,"name":..,"version":<u64 ms>}`, `list`·`index` → `{"ok":true,"entries":[NasEntry..]}`, `read` → `{"ok":true,"size":<전체 크기>}` 다음 줄부터 `start`~끝 원본 바이트.
  - `fn serve(stream: impl Read + Write, host: &HostCtx, verify: &dyn Fn(&str) -> bool)` — 연결 하나 처리(테스트에서 `verify`를 바꿔 끼운다).
  - 커맨드: `nas_host_start(app, root: String, name: String, server: String) -> Result<(), String>`, `nas_host_stop(app)`, `nas_host_status() -> HostStatus`, `nas_verify_reply(id: String, ok: bool)`
  - `#[derive(Serialize, Clone)] #[serde(rename_all = "camelCase")] pub struct HostStatus { open: bool, root: Option<String>, indexed: usize, indexing: bool, error: Option<String> }`
  - 이벤트: `nas-verify` (payload `{ id: String, token: String }`), `nas-host-status` (payload `HostStatus`)

- [ ] **Step 1: 실패하는 테스트 작성** — 루프백 TCP(`127.0.0.1:0`)에 평문 `serve`를 붙여 요청·응답을 본다(TLS는 `tls.rs`가 이미 테스트됨).

```rust
#[test] fn refuses_without_verified_token() { /* verify=|_| false, op "list" → ok:false, error "로그인 확인에 실패했습니다" */ }
#[test] fn info_list_and_read_from_offset() {
    // root에 "a.bin"=b"0123456789". verify=|_| true
    // info → name=="디자인나스"; list "/" → ["a.bin"]; read path "/a.bin" start 4 → size==10, 이어지는 바이트 == b"456789"
}
#[test] fn read_outside_root_is_refused() { /* read "/../x" → ok:false */ }
#[test] fn verify_timeout_refuses() { /* host 쪽 verify 대기 함수 wait_verify(id, Duration::from_millis(50)) 가 응답 없으면 false */ }
```

- [ ] **Step 2: 실패 확인** — Run: `cd src-tauri && cargo test --lib nas::` → 컴파일 실패
- [ ] **Step 3: 구현**
  - 상태 `pub struct NasHost`(app.manage): 루트, 이름, 서버, `Arc<tls::Identity>`, 리스너 스레드, `mdns_sd::ServiceDaemon`(등록 fullname), 색인 `RwLock<Arc<(u64 /*version ms*/, Vec<NasEntry>)>>`, 확인 캐시 `Mutex<HashMap<String /*sha256 hex*/, Instant>>`, 대기 중 확인 `Mutex<HashMap<String, mpsc::Sender<bool>>>`, 감시 `Debouncer`.
  - 토큰 확인: 캐시(10분)에 있으면 통과. 없으면 `nas-verify` 이벤트 → `mpsc` 10초 대기(`wait_verify`) → `nas_verify_reply`가 보낸 값. 시간 초과 = 거절.
  - 색인: 열 때 스레드에서 `build_index`(진행은 `nas-host-status`로 1000개마다), 60초 디바운스 감시(`notify_debouncer_mini`, `RecursiveMode::Recursive`) 후 다시, 24시간 타이머. 만드는 동안 이전 색인을 계속 준다.
  - `read`: `resolve_in` → 파일 열고 `start`로 seek → 64KB씩 복사. 크기는 `metadata().len()`.
  - 같은 루트로 다시 `start`하면 아무것도 안 함. 다른 루트면 stop 후 start. `stop`은 mDNS unregister(1초 대기)·리스너 종료·감시 해제.
- [ ] **Step 4: 통과 확인** — 같은 명령 → PASS, `cargo build` 경고 없음
- [ ] **Step 5: Commit** — `git commit -m "feat(nas): 제공 쪽 서버 — 토큰 확인, 목록·색인·읽기, mDNS 알림"`

---

### Task 3: Rust `nas` — 받는 쪽 찾기·요청·내려받기

**Files:**
- Modify: `src-tauri/src/nas.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: Task 2의 `Req`·응답 형식·`serve`, `tls::connect(sock, fp)`
- Produces:
  - `#[derive(Serialize, Clone)] #[serde(rename_all = "camelCase")] pub struct NasPeer { id: String /*mDNS fullname*/, name: String, addrs: Vec<SocketAddr>, fp: String }`
  - 커맨드: `nas_browse(app, server: String)`(같은 server면 그대로, 다르면 새로), `nas_peers() -> Vec<NasPeer>`, `nas_info(peer: String, token: String) -> Result<NasInfo, String>` (`NasInfo { name: String, version: u64 }`), `nas_list(peer, token, path: String) -> Result<Vec<NasEntry>, String>`, `nas_index(peer, token) -> Result<Vec<NasEntry>, String>`, `nas_download(app, peer, token, path: String, dest: String, id: String) -> Result<(), String>` (async)
  - 이벤트: `nas-peers` (payload `Vec<NasPeer>`), `nas-download` (payload `{ id, got: u64, total: u64 }`, 100ms에 한 번)
  - 연결 실패 문구 통일: `"디자인나스에 연결할 수 없습니다. 서버 PC의 Drive 앱이 켜져 있는지 확인하세요"`

- [ ] **Step 1: 실패하는 테스트 작성**

```rust
#[test] fn client_request_roundtrip() { /* Task 2 serve를 루프백에 띄우고, 클라이언트 쪽 fn request(stream, &Req) -> Result<serde_json::Value,String> 로 list 결과 확인 */ }
#[test] fn download_removes_partial_file() {
    // serve 대신 가짜 서버: 헤더 {"ok":true,"size":100} 후 10바이트만 쓰고 끊음
    // fn receive_to(stream, dest, total_cb) 가 Err, dest 파일 없음
}
```

- [ ] **Step 2: 실패 확인** — Run: `cd src-tauri && cargo test --lib nas::` → FAIL
- [ ] **Step 3: 구현** — 찾기는 `nearby.rs`의 `start`/`on_event`와 같은 방식(서비스 `_udrive-nas._tcp.local.`, IPv4 주소만, `server`·`v`·`fp` 길이 64 확인, 세대 번호로 늦은 이벤트 버림). 요청마다 새 TCP 연결(5초 연결 시한) + `tls::connect(sock, &peer.fp)`. 내려받기는 `dest`에 바로 쓰고 받은 크기가 `size`보다 작게 끝나거나 오류면 `dest`를 지운다.
- [ ] **Step 4: 통과 확인** — 같은 명령 → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(nas): 받는 쪽 — 찾기, 목록·색인 요청, 내려받기"`

---

### Task 3b: 토큰 확인 걷어내기 (사용자 결정으로 추가)

**Files:**
- Modify: `src-tauri/src/nas.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json`

**Interfaces:**
- Produces: `Req`에서 `token` 필드 삭제. `serve(stream, host: &HostCtx)` (verify 인자 삭제). 커맨드 `nas_verify_reply`와 이벤트 `nas-verify`, 확인 캐시·대기(`verified`, `pending`, `wait_verify`, `check`) 삭제. 받는 쪽 커맨드에서 `token` 인자 삭제: `nas_info(peer)`, `nas_list(peer, path)`, `nas_index(peer)`, `nas_download(app, peer, path, dest, id)`.

- [ ] **Step 1: 테스트 고치기** — 토큰 관련 테스트(`refuses_without_verified_token`, `verify_timeout_refuses`, 캐시 테스트)를 지우고, `request_has_no_token`을 넣는다: 클라이언트가 보내는 요청 줄(직렬화한 `Req`)에 `"token"` 문자열이 없다.
- [ ] **Step 2: 실패 확인** — `cd src-tauri && cargo test --lib nas::` → 컴파일 실패 또는 FAIL
- [ ] **Step 3: 구현** — 위 Produces대로 지운다. 남은 동작(경로 제한, 읽기 전용, 동시 연결 한도, 시간 제한, 색인)은 그대로.
- [ ] **Step 4: 통과 확인** — `cargo test --lib`, `cargo build` 경고 없음, clippy nas*.rs 0건
- [ ] **Step 5: Commit** — `git commit -m "fix(nas): 토큰을 보내지 않는다 — 로그인 확인 흐름 삭제"`

---

### Task 4: `withNas` — NAS를 읽기 전용 라이브러리로

**Files:**
- Create: `src/storage/nas/native.ts`, `src/storage/nas/withNas.ts`, `src/storage/nas/withNas.test.ts`
- Modify: `src/storage/StorageProvider.ts` (`Library`에 `nas?: boolean`), `src/storage/StorageContext.tsx` (provider를 `isTauri() ? withNas(p, nasClient) : p`)

**Interfaces:**
- Consumes: Task 3 커맨드·이벤트
- Produces:
  - `export type NasPeer = { id: string; name: string }`
  - `export type NasClient = { peers(): NasPeer[]; info(peerId: string): Promise<{ name: string; version: number }>; list(peerId: string, path: string): Promise<Entry[]>; index(peerId: string): Promise<Entry[]> }` — `native.ts`의 `nasClient`가 구현. `Entry.id`는 `path`로 채운다.
  - `native.ts`: `export const nasClient: NasClient`, `export function onNasPeers(cb: () => void): () => void`, `export function startNasBrowse(server: string): Promise<void>`, `export async function nasDownload(url: string, dest: string, onProgress: (got: number, total: number) => void): Promise<void>`
  - `withNas.ts`: `export const NAS_PREFIX = "nas:"`, `export function withNas(inner: StorageProvider, client: NasClient): StorageProvider`, `export function nasUrl(peerId: string, path: string): string` → `` `nas://${encodeURIComponent(peerId)}${path}` ``, `export function parseNasUrl(url: string): { peerId: string; path: string } | null`

- [ ] **Step 1: 실패하는 테스트 작성** (`withNas.test.ts`, 가짜 inner(`listLibraries` → `[seafileLib]`)·가짜 client)

```ts
it("listLibraries adds one read-only NAS library per peer, uses index version as headCommitId", async () => {
  // client.peers → [{id:"p1",name:"x"}], info → {name:"디자인나스", version:42}
  expect(libs[1]).toMatchObject({ id: "nas:p1", name: "디자인나스", section: "NAS", readOnly: true, nas: true, headCommitId: "42", encrypted: false });
});
it("peer whose info fails is left out", ...);
it("listDir / listTree on nas: go to the client", ...);
it("list error becomes network StorageError", async () => {
  await expect(p.listDir("nas:p1", "/")).rejects.toMatchObject({ kind: "network", message: "디자인나스에 연결할 수 없습니다. 서버 PC의 Drive 앱이 켜져 있는지 확인하세요" });
});
it("downloadUrl gives nas:// url and parseNasUrl reverses it", ...); // 한글·공백 경로 포함
it("mutations and thumbnail on nas: reject, other libIds pass through", ...);
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/storage/nas/withNas.test.ts` → FAIL
- [ ] **Step 3: 구현** — `libId`가 `NAS_PREFIX`로 시작하면 NAS, 아니면 `inner`로. NAS에서 `upload`·`mkdir`·`rename`·`remove`·`move`·`createShareLink`·`emptyTrash`·`restoreTrash`·`previewUrl`·`readText`·`thumbnail`은 `StorageError("server", "디자인나스는 내려받기만 할 수 있습니다")`, `listTrash`는 `[]`. `token`·`login`·`logout`·`isLoggedIn`·계정·그룹·공유 링크 목록은 그대로 위임.
- [ ] **Step 4: 통과 확인** — `npm test && npx tsc --noEmit && npm run lint` → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(nas): withNas — 디자인나스를 읽기 전용 라이브러리로"`

---

### Task 5: 받는 쪽 화면 연결 — 찾기, 내려받기, 미리보기 끄기

**Files:**
- Create: `src/features/nas/NasRoot.tsx`
- Modify: `src/App.tsx` (`<SyncRoot />` 옆에 `<NasRoot />`), `src/features/download/useDownloads.ts` (`tauriSaver`), `src/features/browse/MainScreen.tsx:244-250`

**Interfaces:**
- Consumes: Task 4 `startNasBrowse`, `onNasPeers`, `parseNasUrl`, `nasDownload`, `Library.nas`

- [ ] **Step 1: 실패하는 테스트 작성** — `useDownloads`의 저장 함수 분기를 순수 함수로 뺀다: `export function pickSaver(url: string): "nas" | "http"` 테스트(`nas://p1/a.psd` → `"nas"`, `https://…` → `"http"`) in `src/features/download/useDownloads.test.ts`.
- [ ] **Step 2: 실패 확인** — `npx vitest run src/features/download/useDownloads.test.ts` → FAIL
- [ ] **Step 3: 구현**
  - `NasRoot`: `isTauri()`이고 로그인돼 있으면 `startNasBrowse(session.connection.baseUrl)`. `onNasPeers`마다 `qc.invalidateQueries({ queryKey: ["libraries"] })`. 화면 없음(`null`).
  - `tauriSaver`: `pickSaver(url) === "nas"`면 `nasDownload(url, path, onProgress)`(100ms 스로틀은 Rust가 함), 아니면 기존 upload 플러그인.
  - `MainScreen`: `lib?.nas`면 `previewable = []`, `open()`에서 미리보기 대신 내려받기.
- [ ] **Step 4: 통과 확인** — `npm test && npx tsc --noEmit && npm run lint` → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(nas): 사이드바에 디자인나스, nas:// 내려받기, 미리보기 끔"`

---

### Task 6: 제공 쪽 — 설정 "NAS로 열기"와 자동 열기

**Files:**
- Create: `src/features/nas/NasHostRoot.tsx`, `src/features/settings/NasPage.tsx`, `src/features/settings/keepAppOn.ts` (+ `keepAppOn.test.ts`)
- Modify: `src/features/settings/appPrefs.ts` (`nasRoot: string | null`, 기본 `null`), `src/features/settings/SettingsDialog.tsx` (`SettingsPage`에 `"nas"`, 메뉴 이름 "NAS"), `src/features/sync/useAddSyncFolder.ts` (켜 두기 확인·켜기를 `keepAppOn.ts`로 옮겨 재사용), `src/App.tsx` (`<NasHostRoot />`)

**Interfaces:**
- Consumes: Task 2 커맨드·이벤트(`nas_host_start`/`nas_host_stop`/`nas_host_status`, `nas-host-status`), `pickFolder`(`src/features/upload/localUpload.ts`, 제목 인자 추가: `pickFolder(title = "업로드할 폴더")`), `isPersistent`, `makePersistent`
- Produces:
  - `keepAppOn.ts`: `export async function needsKeepOn(): Promise<{ any: boolean; autoLoginOff: boolean }>`, `export async function enableKeepOn(makePersistent: () => void): Promise<string | null>` (실패 문구 또는 null) — `useAddSyncFolder`의 기존 동작과 같다.

- [ ] **Step 1: 실패하는 테스트 작성** (`keepAppOn.test.ts`: autostart 모듈을 `vi.mock`, 자동 실행 꺼짐·트레이 꺼짐·자동 로그인 꺼짐 각각에서 `any === true`, 모두 켜짐이면 `false`. `enableKeepOn`이 `setPrefs({closeToTray:true})`와 `makePersistent`를 부른다)
- [ ] **Step 2: 실패 확인** — `npx vitest run src/features/settings/keepAppOn.test.ts` → FAIL
- [ ] **Step 3: 구현**
  - `NasHostRoot`: `isTauri()`·로그인·`prefs.nasRoot`가 있으면 `nas_host_start(nasRoot, account.name, baseUrl)`, 없어지면 `nas_host_stop`.
  - `NasPage`: 닫힘이면 문구 "이 PC에 연결된 하드 폴더를 열어 두면, 같은 사무실 네트워크의 Drive 앱에 '{계정 이름}'으로 보입니다." + [폴더 골라서 열기]. 고르면 확인 창: "'{폴더}'를 열까요? 내려받기만 할 수 있고, 파일은 바뀌지 않습니다." + 켜 두기 체크박스(`needsKeepOn().any`일 때, 기본 체크, 문구 "앱을 켜 두는 설정도 함께 켜기" — 자동 로그인이 꺼져 있으면 "자동 로그인이 꺼져 있어 PC를 다시 켜면 멈춥니다." 덧붙임) [취소]/[열기] → `setPrefs({ nasRoot })`. 열림이면 경로, "검색 색인 {indexed}개{indexing ? ' 만드는 중…' : ''}", 오류 문구, [닫기] → `setPrefs({ nasRoot: null })`. 상태는 `nas_host_status` + `nas-host-status` 이벤트.
  - 처음 열 때 Windows 방화벽 창이 뜨면 "개인 네트워크"를 허용하라는 한 줄을 확인 창에 둔다.
- [ ] **Step 4: 통과 확인** — `npm test && npx tsc --noEmit && npm run lint` → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(nas): 설정에서 NAS로 열기, 로그인하면 자동으로 다시 열기"`

---

### Task 7: 전체 점검과 문서

**Files:**
- Modify: `docs/superpowers/specs/2026-11-03-nas-browse-design.md` (초기 설정 4번: 확인 창에서 크기·파일 수를 미리 세지 않고, 연 뒤 색인 진행으로 보여 준다 — 3TB를 미리 세면 몇 분 걸려서)
- 같은 문서 "2. 접근 확인"을 인증 없음(토큰을 보내지 않음, 이유 포함)으로 바꾸고, "정한 것"의 "권한은 하나"를 "사무실 네트워크 안의 Drive 앱이면 누구나"로 고친다
- 같은 문서 1번의 "회사 네트워크에서만 켠다"를 지운다: 제공 쪽은 Seafile 서버 PC라 늘 사무실 안이고, 받는 쪽은 찾기만 하고 자신을 알리지 않는다
- Create: `docs/superpowers/plans/2026-11-04-nas-browse-test-checklist.md`

- [ ] **Step 1: 자동 검사** — Run: `npm test && npx tsc --noEmit && npm run lint && (cd src-tauri && cargo test)` → 모두 PASS. `cargo clippy`는 새 파일(`nasfs.rs`, `nas.rs`)에 경고가 없어야 한다(기존 파일 경고 5개는 범위 밖).
- [ ] **Step 2: 수동 테스트 목록 작성** — PC 두 대(제공·받는 쪽) 기준: 열기·방화벽 허용·사이드바 표시·폴더 탐색·검색·큰 파일 내려받기·제공 쪽 앱 끄면 사라짐·다른 서버 계정에는 안 보임·서버 PC 재부팅 후 자동으로 다시 열림.
- [ ] **Step 3: 줄끝 확인** — Run: `git ls-files --eol src/storage/nas src/features/nas src-tauri/src/nas*.rs` → 모두 `w/crlf`
- [ ] **Step 4: Commit** — `git commit -m "docs(nas): 수동 테스트 목록, 설계 문서 갱신"`
