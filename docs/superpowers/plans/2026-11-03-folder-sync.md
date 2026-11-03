# 폴더 동기화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데스크톱 앱에서 PC 폴더를 드라이브 폴더에 연결해, PC에서 저장·수정·삭제한 결과가 드라이브에 자동으로 단방향 미러링되게 한다.

**Architecture:** Rust가 PC 폴더 훑기(`sync_scan`), OS 변경 알림 감시(`notify`, 1.5초 디바운스 후 `sync-changed` 이벤트), 기준 상태 파일 저장을 맡는다. JS는 순수 함수 `planSync`(PC 현재 + 기준 상태 → 할 일)와 `runLink`(할 일을 기존 `UploadQueue`·`StorageProvider`로 실행)를 갖고, 로그인 화면 안의 화면 없는 `SyncRoot`가 감시 이벤트·시작·1시간 타이머로 `runLink`를 부른다. 알림은 "다시 비교하라"는 신호로만 쓴다.

**Tech Stack:** Tauri 2 (Rust), `notify` + `notify-debouncer-mini`, React 19, TanStack Query, Vitest.

**Spec:** [docs/superpowers/specs/2026-11-03-folder-sync-design.md](../specs/2026-11-03-folder-sync-design.md)

## Global Constraints

- 단방향: PC → 드라이브. 동기화는 PC 파일을 **읽기만** 한다(쓰기·삭제·이동 금지).
- 동기화는 **기준 상태에 있는 파일·폴더만** 드라이브에서 지운다.
- 올리지 않는 이름: `~$*`, `*.tmp`(대소문자 무시, `~*.tmp` 포함), `Thumbs.db`, `desktop.ini`, `.`으로 시작하는 모든 파일·폴더(`.DS_Store` 포함). 제외된 폴더는 하위 전체를 건너뛴다. 코드 상수, 사용자 설정 없음.
- 대량 삭제 확인: 지울 파일 수가 `(기준 상태 파일 수의 50% 이상 AND 10개 이상) OR 500개 초과`.
- 전체 비교 주기: 1시간(`3_600_000`ms). 감시 디바운스 1.5초. "쓰는 중" 판단: 수정 시각이 지금부터 3초 이내.
- 데스크톱 앱 전용: 웹(`!isTauri()`)에서는 모든 동기화 메뉴·엔진을 숨긴다.
- 새 Tauri 커맨드는 `src-tauri/build.rs`의 `COMMANDS`와 `src-tauri/capabilities/default.json`의 `allow-…`에 **둘 다** 넣는다.
- 파일 줄끝: 새 파일·수정 파일 모두 CRLF로 맞춘다(일부 LF 파일은 원래 줄끝 유지). `git ls-files --eol <file>`로 확인. `npx prettier --write` 금지.
- 사용자에게 보이는 문구는 한국어, 스펙의 문구를 그대로 쓴다.

## Review Focus

1. **PC 폴더가 사라짐**(외장 하드 분리, 폴더 이름 변경): 드라이브에서 아무것도 지우면 안 된다 → Task 5 `runLink` 테스트 "local missing deletes nothing".
2. **스캔 결과가 비어 있음**(빈 폴더로 바뀜, 권한 문제로 목록이 비어 옴): 대량 삭제 확인으로 멈춰야 한다 → Task 3 `planSync` 테스트 "all files gone triggers mass delete".
3. **드라이브에 같은 이름 빈 폴더 만들기**: Seafile `mkdir`는 이미 있으면 다른 이름으로 새로 만들 수 있으므로, 있으면 만들지 않아야 한다 → Task 5 테스트 "mkdir skips existing dir".
4. **삭제한 PC 폴더 안에 드라이브에서 직접 넣은 파일이 있음**: 폴더를 지우지 않고 남겨야 한다 → Task 5 테스트 "removeDirs keeps non-empty drive dir".
5. **업로드가 실패하거나 사용자가 패널에서 취소**: 기준 상태에 반영되지 않아 다음 확인 때 다시 올라가야 한다 → Task 5 테스트 "failed or cancelled upload stays out of baseline".

---

## 파일 구조

```
src-tauri/src/syncfs.rs          # 새: 폴더 훑기·제외 규칙·감시·기준 상태 파일
src/features/sync/
├── type.ts                      # SyncLink, Baseline, Scan, SyncPlan, LinkState
├── constants.ts                 # 숫자 상수
├── planSync.ts (+ .test.ts)     # 순수 비교 함수
├── links.ts (+ .test.ts)        # 연결 목록 저장(localStorage)·경로 헬퍼
├── checkNewLink.ts (+ .test.ts) # 연결 만들기 전 검사(순수)
├── runLink.ts (+ .test.ts)      # 한 연결 동기화 실행
├── syncState.ts                 # 연결별 진행 상태 메모리 스토어(useSyncExternalStore)
├── native.ts                    # Rust 커맨드·이벤트 래퍼
├── SyncRoot.tsx                 # 화면 없는 엔진 컴포넌트
├── MassDeleteDialog.tsx
├── useAddSyncFolder.ts          # 추가 흐름 훅
├── AddSyncDialog.tsx            # 크기·이어서 연결·켜 두기 안내 확인 창
├── useSyncGuard.ts              # 동기화 폴더 안 변경 경고 훅
├── SyncWarningDialog.tsx
├── SyncBadge.tsx                # 폴더 아이콘 위 표시
└── SyncDetails.tsx              # 상세 패널 섹션
```

---

### Task 1: 숨김 실행 확인 (스파이크, 커밋 없음)

창 없이 자동 실행됐을 때 WebView 타이머·이벤트·업로드가 도는지 먼저 확인한다. 결과에 따라 Task 6 설계가 바뀔 수 있다.

**Files:** 임시 수정만 (`src/App.tsx`), 끝나면 되돌린다.

- [ ] **Step 1: 임시 로그 넣기**

`Gate`의 로그인된 분기에서 `useEffect`로 60초마다 `logError("sync-spike", new Error(new Date().toISOString()))`를 남기는 임시 코드를 넣는다.

- [ ] **Step 2: 로그인 상태로 숨김 실행**

"자동 로그인"을 체크해 로그인한 뒤 앱을 종료하고 `npm run tauri dev -- -- --autostart`로 띄운다(창이 숨겨진 상태로 시작). 15분 둔다.

- [ ] **Step 3: 확인**

트레이 메뉴 → 로그 폴더 열기. 기대: 로그 줄이 약 1분 간격(최대 수 분 지연까지는 허용)으로 15분 내내 찍혀 있다. 자동 로그인이 꺼진 상태로 같은 실행을 하면 로그가 없어야 한다(로그인 화면).

- [ ] **Step 4: 되돌리기**

`git checkout src/App.tsx`. 결과를 계획 실행 기록에 남긴다. 타이머가 10분 넘게 멈춘다면, 1시간 전체 비교 신호를 Rust 쪽 타이머(`sync-changed`를 1시간마다 emit)로 옮기도록 Task 2에 추가한다.

---

### Task 2: Rust `syncfs` — 훑기·제외 규칙·감시·기준 상태 파일

**Files:**
- Create: `src-tauri/src/syncfs.rs`
- Modify: `src-tauri/Cargo.toml` (`[dependencies]`), `src-tauri/src/lib.rs` (`mod syncfs;`, `.manage(...)`, `generate_handler!`), `src-tauri/build.rs` (`COMMANDS`), `src-tauri/capabilities/default.json`

**Interfaces:**
- Produces (Tauri 커맨드, JS에서 camelCase 인자):
  - `sync_scan(root: String) -> Result<SyncScan, String>` — `SyncScan { files: Vec<ScanFile>, dirs: Vec<String>, total_bytes: u64 }`, `ScanFile { rel: String, path: String, size: u64, mtime: f64 }`. `rel`은 `/` 구분 상대 경로(`"기획/a.docx"`), `dirs`는 모든 하위 폴더 상대 경로(루트 제외). serde `rename_all = "camelCase"`. 루트가 없거나 폴더가 아니면 `Err("NOT_FOUND")`.
  - `sync_watch(id: String, root: String) -> Result<(), String>` — 1.5초 디바운스 후 이벤트 `sync-changed`(payload: `id` 문자열) emit. 같은 id로 다시 부르면 기존 감시를 교체한다. 감시 오류 이벤트도 같은 이벤트로 알린다.
  - `sync_unwatch(id: String)`
  - `sync_state_read(id: String) -> Result<Option<String>, String>`, `sync_state_write(id: String, json: String) -> Result<(), String>`, `sync_state_delete(id: String) -> Result<(), String>` — `<app_data_dir>/sync/<id>.json`. `id`가 `^[A-Za-z0-9-]{1,64}$`가 아니면 `Err`.

- [ ] **Step 1: 의존성 추가**

Run: `cd src-tauri && cargo add notify notify-debouncer-mini`
Expected: `Cargo.toml`에 두 줄 추가, `cargo check` 통과. 추가한 줄 위에 한 줄 주석 `# 폴더 동기화: PC 폴더 변경 알림(ReadDirectoryChangesW/FSEvents/inotify)`.

- [ ] **Step 2: 실패하는 테스트 작성** (`syncfs.rs`의 `#[cfg(test)] mod tests`, `localfs.rs` 테스트의 `temp_dir` 방식)

```rust
#[test]
fn ignored_names() {
    for n in ["~$기획안.docx", "a.tmp", "~WRL0001.TMP", "Thumbs.db", "desktop.ini", ".DS_Store", ".git"] { assert!(ignored(n), "{n}"); }
    for n in ["기획안.docx", "tmp", "a.tmpl", "보고서~.docx"] { assert!(!ignored(n), "{n}"); }
}

#[test]
fn scan_lists_files_and_dirs_skipping_ignored() {
    // d/a.docx(2B), d/sub/b.txt(3B), d/빈폴더/, d/~$a.docx, d/.hidden/c.txt
    let s = scan(&d).unwrap();
    // files rel: ["a.docx", "sub/b.txt"], dirs: ["sub", "빈폴더"] (정렬 후 비교), total_bytes: 5
}

#[test]
fn scan_missing_root_is_not_found() {
    assert_eq!(scan(&d.join("없음")).unwrap_err(), "NOT_FOUND");
}

#[test]
fn state_id_rejects_traversal() {
    assert!(state_path(&base, "../x").is_err());
    assert!(state_path(&base, "abc-123").is_ok());
}
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd src-tauri && cargo test syncfs`
Expected: FAIL (함수 없음)

- [ ] **Step 4: 구현**

- `fn ignored(name: &str) -> bool`, `fn scan(root: &Path) -> Result<SyncScan, String>`, `fn state_path(base: &Path, id: &str) -> Result<PathBuf, String>`.
- `scan`은 `localfs.rs`의 `walk`와 같은 규칙: 링크된 폴더는 따라가지 않고, 링크된 파일은 가리키는 파일을 쓴다. 읽을 수 없는 하위 항목은 건너뛴다(루트만 `NOT_FOUND`).
- 감시 핸들은 `Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>`를 `app.manage()`로 둔다. `new_debouncer(Duration::from_millis(1500), move |_res| { let _ = app.emit("sync-changed", &id); })`, `watch(root, RecursiveMode::Recursive)`.
- 커맨드 7개를 `generate_handler!`, `build.rs` `COMMANDS`, `default.json`(`allow-sync-scan` 등)에 넣는다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd src-tauri && cargo test syncfs && cargo clippy -- -D warnings`
Expected: PASS, 경고 없음

- [ ] **Step 6: Commit**

```bash
git add src-tauri/
git commit -m "feat(sync): Rust 폴더 훑기·변경 감시·기준 상태 파일 커맨드"
```

---

### Task 3: 타입·상수·`planSync`

**Files:**
- Create: `src/features/sync/type.ts`, `src/features/sync/constants.ts`, `src/features/sync/planSync.ts`, `src/features/sync/planSync.test.ts`

**Interfaces:**
- Produces:

```ts
// type.ts
export type ScanFile = { rel: string; path: string; size: number; mtime: number }; // mtime: 유닉스 초
export type Scan = { files: ScanFile[]; dirs: string[]; totalBytes: number };
export type Baseline = { files: Record<string, { size: number; mtime: number }>; dirs: string[] };
export type SyncLink = {
  id: string;          // crypto.randomUUID()
  account: string;     // `${baseUrl}|${email}`
  libId: string;
  drivePath: string;   // 연결된 드라이브 폴더, '/'로 시작
  localRoot: string;   // PC 폴더 절대 경로
  paused: boolean;
  fresh: boolean;      // 기존 폴더에 이어서 연결: 첫 동기화에서 지우지 않는다
};
export type SyncStatus = "idle" | "syncing" | "paused" | "needsConfirm" | "localMissing" | "driveMissing" | "error";
export type LinkState = { status: SyncStatus; pending: number; lastSyncedAt: number | null; error?: string; deleteCount?: number };
export type SyncPlan = { uploads: ScanFile[]; mkdirs: string[]; removeFiles: string[]; removeDirs: string[]; deferred: number; massDelete: boolean };

// constants.ts
export const SETTLE_SEC = 3;
export const FULL_SCAN_MS = 3_600_000;
export const MASS_DELETE_MIN = 10;
export const MASS_DELETE_RATIO = 0.5;
export const MASS_DELETE_MAX = 500;

// planSync.ts
export function planSync(scan: Scan, base: Baseline, opts: { nowSec: number; fresh: boolean; confirmedDeletes?: boolean }): SyncPlan;
export function emptyBaseline(): Baseline;
```

규칙:
- `uploads`: 기준 상태에 없거나 size·mtime 중 하나라도 다른 파일. 단 `nowSec - mtime < SETTLE_SEC`인 파일은 빼고 `deferred`로 센다.
- `mkdirs`: `scan.dirs` 중 `base.dirs`에 없는 것, 얕은 것부터.
- `removeFiles`: `base.files`에 있는데 `scan.files`에 없는 것. `removeDirs`: `base.dirs`에 있는데 `scan.dirs`에 없는 것, 깊은 것부터.
- `fresh`면 `removeFiles`·`removeDirs`는 항상 빈 배열.
- `massDelete`: `!confirmedDeletes && (removeFiles.length > MASS_DELETE_MAX || (removeFiles.length >= MASS_DELETE_MIN && removeFiles.length >= base 파일 수 * MASS_DELETE_RATIO))`.

- [ ] **Step 1: 실패하는 테스트 작성** (`planSync.test.ts`)

```ts
const f = (rel: string, size = 1, mtime = 100): ScanFile => ({ rel, path: `C:/p/${rel}`, size, mtime });
const scan = (files: ScanFile[], dirs: string[] = []): Scan => ({ files, dirs, totalBytes: 0 });
const base = (files: ScanFile[], dirs: string[] = []): Baseline => ({ files: Object.fromEntries(files.map((x) => [x.rel, { size: x.size, mtime: x.mtime }])), dirs });
const opts = { nowSec: 1000, fresh: false };

it("uploads new and changed files only", () => {
  const p = planSync(scan([f("a"), f("b", 2), f("c")]), base([f("a"), f("b", 1)]), opts);
  expect(p.uploads.map((x) => x.rel)).toEqual(["b", "c"]);
});
it("defers files modified within SETTLE_SEC", () => {
  const p = planSync(scan([f("a", 1, 999)]), emptyBaseline(), opts);
  expect(p.uploads).toEqual([]); expect(p.deferred).toBe(1);
});
it("removes baseline files missing locally", () => {
  expect(planSync(scan([f("a")]), base([f("a"), f("b")]), opts).removeFiles).toEqual(["b"]);
});
it("orders mkdirs shallow-first and removeDirs deep-first", () => {
  const p = planSync(scan([], ["x", "x/y"]), base([], ["z", "z/w"]), opts);
  expect(p.mkdirs).toEqual(["x", "x/y"]); expect(p.removeDirs).toEqual(["z/w", "z"]);
});
it("fresh link never removes", () => {
  const p = planSync(scan([]), base([f("a")], ["d"]), { ...opts, fresh: true });
  expect(p.removeFiles).toEqual([]); expect(p.removeDirs).toEqual([]);
});
it("all files gone triggers mass delete", () => {
  const ten = Array.from({ length: 10 }, (_, i) => f(`f${i}`));
  expect(planSync(scan([]), base(ten), opts).massDelete).toBe(true);
});
it("small deletions do not trigger mass delete", () => {
  const ten = Array.from({ length: 10 }, (_, i) => f(`f${i}`));
  expect(planSync(scan(ten.slice(0, 1)), base(ten.slice(0, 2)), opts).massDelete).toBe(false); // 1개
  expect(planSync(scan(ten.slice(0, 1)), base(ten), opts).massDelete).toBe(false); // 9개: 90%지만 10개 미만
});
it("over 500 deletions trigger even at low ratio", () => {
  const many = Array.from({ length: 2000 }, (_, i) => f(`f${i}`));
  expect(planSync(scan(many.slice(0, 1499)), base(many), opts).massDelete).toBe(true); // 501개
});
it("confirmedDeletes bypasses mass delete", () => {
  const ten = Array.from({ length: 10 }, (_, i) => f(`f${i}`));
  expect(planSync(scan([]), base(ten), { ...opts, confirmedDeletes: true }).massDelete).toBe(false);
});
```

두 번째 small 단언은 `expect(...).toBe(false)`로 쓴다(9개는 10개 미만).

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/features/sync/planSync.test.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/features/sync/planSync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/sync/
git commit -m "feat(sync): 동기화 비교 함수 planSync"
```

---

### Task 4: 연결 목록 저장·경로 헬퍼·연결 전 검사

**Files:**
- Create: `src/features/sync/links.ts`, `links.test.ts`, `checkNewLink.ts`, `checkNewLink.test.ts`

**Interfaces:**
- Consumes: `SyncLink` (Task 3)
- Produces:

```ts
// links.ts — localStorage "seadrive.sync.links"(모든 계정의 SyncLink[]), appPrefs.ts와 같은 useSyncExternalStore 패턴
export function accountKey(baseUrl: string, email: string): string;              // `${baseUrl}|${email}`
export function useLinks(account: string): SyncLink[];
export function getLinks(account: string): SyncLink[];
export function addLink(link: SyncLink): void;
export function updateLink(id: string, patch: Partial<SyncLink>): void;
export function removeLink(id: string): void;
/** path가 연결 폴더 자체이거나 그 안이면 그 연결 */
export function findLink(links: SyncLink[], libId: string, path: string): SyncLink | undefined;
/** 앱 안 이름 변경·이동: oldPath가 연결 폴더이거나 그 조상이면 drivePath 앞부분을 newPath로 바꾼 목록 */
export function followMove(links: SyncLink[], libId: string, oldPath: string, newPath: string): SyncLink[];

// checkNewLink.ts
export type NewLinkCheck = { ok: true; existing: boolean } | { ok: false; reason: string };
export function checkNewLink(a: {
  links: SyncLink[]; libId: string; dir: string; localRoot: string; name: string;
  lib: { readOnly?: boolean; encrypted: boolean };
  existing: { type: "file" | "dir" } | undefined;   // 지금 폴더에서 name과 같은 항목
  totalBytes: number; quotaLeft: number | null;     // null = 무제한
}): NewLinkCheck;
```

`checkNewLink` 거부 문구(순서대로 검사):
- 읽기 전용: "읽기 전용 저장소에는 동기화 폴더를 만들 수 없습니다"
- 암호화: "암호화된 저장소에는 동기화 폴더를 만들 수 없습니다"
- `findLink(links, libId, dir)`: "이미 동기화 중인 폴더 안에는 만들 수 없습니다"
- PC 경로가 기존 연결의 `localRoot`와 같거나 서로 포함: "이미 동기화 중인 PC 폴더와 겹칩니다". 비교는 `\`→`/`, 끝 `/` 제거, Windows 경로(`/^[a-z]:/i` 또는 `\\`로 시작)는 소문자로.
- `existing?.type === "file"`: "같은 이름의 파일이 있습니다"
- `quotaLeft !== null && totalBytes > quotaLeft`: "드라이브 남은 용량이 부족합니다"
- 통과: `{ ok: true, existing: existing?.type === "dir" }`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// links.test.ts
const L = (p: Partial<SyncLink>): SyncLink => ({ id: "1", account: "a", libId: "lib", drivePath: "/기획안", localRoot: "D:\\기획안", paused: false, fresh: false, ...p });
it("findLink matches root and descendants only", () => {
  expect(findLink([L({})], "lib", "/기획안")?.id).toBe("1");
  expect(findLink([L({})], "lib", "/기획안/하위")?.id).toBe("1");
  expect(findLink([L({})], "lib", "/기획안2")).toBeUndefined();
  expect(findLink([L({})], "other", "/기획안")).toBeUndefined();
});
it("followMove rewrites the link and links under a moved ancestor", () => {
  expect(followMove([L({ drivePath: "/a/기획안" })], "lib", "/a", "/b/a")[0].drivePath).toBe("/b/a/기획안");
  expect(followMove([L({})], "lib", "/기획안", "/새이름")[0].drivePath).toBe("/새이름");
  expect(followMove([L({})], "lib", "/기획", "/x")[0].drivePath).toBe("/기획안");
});

// checkNewLink.test.ts — 위 거부 문구 7가지 각각 1개씩 + 통과 2개(existing false / existing dir → true)
it("rejects overlapping local folders case-insensitively on Windows", () => {
  const r = checkNewLink({ ...ok, links: [L({ localRoot: "D:\\기획안" })], localRoot: "d:/기획안/하위" });
  expect(r).toEqual({ ok: false, reason: "이미 동기화 중인 PC 폴더와 겹칩니다" });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/features/sync/links.test.ts src/features/sync/checkNewLink.test.ts` → FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — 같은 명령 → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): 연결 목록 저장과 연결 전 검사"`

---

### Task 5: `runLink` — 한 연결 동기화 실행

**Files:**
- Create: `src/features/sync/runLink.ts`, `runLink.test.ts`, `src/features/sync/native.ts`

**Interfaces:**
- Consumes: `planSync`, `emptyBaseline` (Task 3), `waitSettled` (`src/features/mcp/waitSettled.ts`), `UploadQueue.add`, `StorageProvider.listDir/mkdir/remove`
- Produces:

```ts
// native.ts — Task 2 커맨드 래퍼(동적 import("@tauri-apps/api/core"), localUpload.ts 방식)
export function scanFolder(root: string): Promise<Scan | "NOT_FOUND">;
export function readBaseline(id: string): Promise<Baseline | null>;
export function writeBaseline(id: string, b: Baseline): Promise<void>;
export function deleteBaseline(id: string): Promise<void>;
export function watchFolder(id: string, root: string): Promise<void>;
export function unwatchFolder(id: string): Promise<void>;
export function onFolderChanged(fn: (id: string) => void): Promise<() => void>;   // "sync-changed"

// runLink.ts
export type RunDeps = {
  storage: Pick<StorageProvider, "listDir" | "mkdir" | "remove">;
  uploads: Pick<UploadQueue, "add" | "subscribe" | "getSnapshot">;
  scan(root: string): Promise<Scan | "NOT_FOUND">;
  readBase(id: string): Promise<Baseline | null>;
  writeBase(id: string, b: Baseline): Promise<void>;
  nowSec(): number;
  onPending?(n: number): void;
};
export type RunResult =
  | { status: "idle"; deferred: number }      // deferred > 0 이면 호출 쪽이 SETTLE_SEC 뒤 다시 부른다
  | { status: "localMissing" | "driveMissing" }
  | { status: "needsConfirm"; deleteCount: number };
export function runLink(link: SyncLink, deps: RunDeps, opts?: { confirmedDeletes?: boolean }): Promise<RunResult>;
```

순서:
1. `scan(localRoot)`가 `"NOT_FOUND"` → `{ status: "localMissing" }` (아무것도 바꾸지 않음).
2. `listDir(libId, drivePath)`가 `StorageError` `kind === "notFound"` → `driveMissing`. 다른 오류는 그대로 throw(401 포함, 호출 쪽 처리).
3. `planSync(scan, base ?? emptyBaseline(), { nowSec, fresh: link.fresh, confirmedDeletes })`. `massDelete`면 `{ status: "needsConfirm", deleteCount: removeFiles.length }`, 아무것도 바꾸지 않음.
4. `mkdirs`: 부모 폴더를 `listDir`해서 같은 이름 폴더가 있으면 만들지 않는다. 성공·이미 있음 모두 기준 상태 `dirs`에 넣는다.
5. `uploads`: `{ file: { name, size, lastModified: mtime*1000, localPath: path }, targetDir: drivePath, relativePath: rel의 부모(없으면 생략) }`로 `uploads.add(libId, tasks)` → `waitSettled(..., s => s === "done" || s === "failed" || s === "cancelled")`. `done`인 것만 기준 상태 `files`에 기록. 업로드로 생긴 상위 폴더도 `dirs`에 넣는다.
6. `removeFiles`: `storage.remove(libId, joinPath(drivePath, rel), "file")`. 성공 또는 `notFound`면 기준 상태에서 뺀다. 다른 오류면 남긴다.
7. `removeDirs`: `listDir`가 비어 있으면 `remove(..., "dir")`. 비어 있지 않거나 `notFound`면 지우지 않는다. 어느 경우든 기준 상태 `dirs`에서 뺀다.
8. 단계마다 성공한 만큼 반영한 기준 상태를 마지막에 `writeBase`로 한 번 저장(중간에 throw해도 `finally`로 저장).

- [ ] **Step 1: 실패하는 테스트 작성** (`runLink.test.ts`)

가짜 의존성: `storage`는 `Map<string, "file"|"dir">`(드라이브 경로 → 종류) 기반 객체, `uploads`는 `add`가 즉시 항목을 만들고 테스트가 지정한 상태(`done`/`failed`/`cancelled`)로 끝내는 객체(`subscribe`/`getSnapshot` 구현), `scan`·`readBase`는 고정값, `writeBase`는 마지막 값 기록.

```ts
it("local missing deletes nothing", async () => {
  const r = await runLink(link, { ...deps, scan: async () => "NOT_FOUND", readBase: async () => base([f("a")]) });
  expect(r).toEqual({ status: "localMissing" }); expect(storage.remove).not.toHaveBeenCalled(); expect(writeBase).not.toHaveBeenCalled();
});
it("drive folder missing stops", async () => { /* listDir drivePath → StorageError("notFound") */ expect(r).toEqual({ status: "driveMissing" }); });
it("mass delete asks and changes nothing", async () => { expect(r).toEqual({ status: "needsConfirm", deleteCount: 10 }); expect(storage.remove).not.toHaveBeenCalled(); });
it("uploads with relativePath and records done files", async () => {
  // scan: "a.docx", "sub/b.docx" → add 호출 인자 relativePath: undefined / "sub", targetDir: "/기획안"; writeBase.files 키 ["a.docx","sub/b.docx"]
});
it("failed or cancelled upload stays out of baseline", async () => { /* a → failed, b → cancelled */ expect(Object.keys(written.files)).toEqual([]); });
it("mkdir skips existing dir", async () => { /* 드라이브에 /기획안/빈폴더 있음 */ expect(storage.mkdir).not.toHaveBeenCalled(); expect(written.dirs).toEqual(["빈폴더"]); });
it("removes baseline files and treats notFound as removed", async () => { /* b 삭제 대상, remove가 notFound throw */ expect(written.files).not.toHaveProperty("b"); });
it("removeDirs keeps non-empty drive dir", async () => { /* base.dirs ["d"], 드라이브 /기획안/d 안에 x.pdf */ expect(storage.remove).not.toHaveBeenCalledWith("lib", "/기획안/d", "dir"); expect(written.dirs).toEqual([]); });
it("fresh link uploads everything and removes nothing", async () => { /* base null, 드라이브에 old.pdf */ expect(storage.remove).not.toHaveBeenCalled(); });
it("deferred count is returned", async () => { /* mtime = now - 1 */ expect(r).toEqual({ status: "idle", deferred: 1 }); });
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/features/sync/runLink.test.ts` → FAIL
- [ ] **Step 3: `native.ts`와 `runLink.ts` 구현**
- [ ] **Step 4: 통과 확인** — 같은 명령 → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(sync): 연결 하나를 동기화하는 runLink"`

---

### Task 6: `SyncRoot` 엔진과 대량 삭제 확인 창

**Files:**
- Create: `src/features/sync/syncState.ts`, `src/features/sync/SyncRoot.tsx`, `src/features/sync/MassDeleteDialog.tsx`
- Modify: `src/App.tsx` (`<NearbyRoot />` 아래에 `<SyncRoot />`)

**Interfaces:**
- Consumes: `runLink`, `native.ts`, `useLinks`, `updateLink`, `accountKey`, `useUploadQueue`, `useStorage`, `useSession().onUnauthorized`
- Produces:

```ts
// syncState.ts — 메모리 스토어
export function useLinkState(id: string): LinkState;
export function useAllLinkStates(): Record<string, LinkState>;
/** 지금 동기화(우클릭 메뉴·다시 시작). confirmedDeletes는 대량 삭제 확인 창의 [계속] */
export function requestRun(id: string, opts?: { confirmedDeletes?: boolean }): void;
```

동작:
- `isTauri()`가 아니면 `null` 반환, 아무것도 안 함.
- 계정 키: `useQuery(["account"])`의 `email`과 `session.connection.baseUrl`. 계정을 모르면 대기.
- 연결마다(일시정지 아님): `watchFolder(id, localRoot)` 시작, 언마운트·일시정지·해제 때 `unwatchFolder`. 감시 시작 실패는 `localMissing`.
- 실행 트리거: 마운트 직후 한 번, `sync-changed`(해당 id), `FULL_SCAN_MS` 간격, `requestRun`. 연결마다 동시에 하나만 돈다. 도는 중 트리거가 오면 끝난 뒤 한 번 더 돈다.
- 결과 처리: `idle` → `lastSyncedAt = Date.now()`, `fresh`였으면 `updateLink(id, { fresh: false })`, `deferred > 0`이면 `SETTLE_SEC`초 뒤 다시. `localMissing`·`driveMissing`은 상태로만 남기고 다음 트리거를 기다린다(`localMissing`이면 감시를 1분마다 다시 시도). `needsConfirm` → 상태 저장.
- `StorageError` `unauthorized` → `onUnauthorized()`. 그 밖의 오류 → `status: "error"`, `error: message`, `logError("sync", e)`.
- `pending`은 `onPending`으로 갱신.
- `MassDeleteDialog`: `needsConfirm`인 연결이 있고 `document.visibilityState === "visible"`일 때, 연결마다 한 번 띄운다. 제목 "파일 {deleteCount}개를 드라이브에서 지울까요?", 설명 "PC의 `{localRoot}` 폴더에서 많은 파일이 사라졌습니다. 계속하면 드라이브의 같은 파일도 지웁니다(휴지통에서 되살릴 수 있습니다)." 버튼 [취소](상태 유지) / [계속](`requestRun(id, { confirmedDeletes: true })`). `DeleteDialog.tsx`의 `Dialog` 구성을 따른다. 상단 X 버튼 없음.

- [ ] **Step 1: 구현** (화면 통합이라 단위 테스트 대신 Step 2 수동 확인)
- [ ] **Step 2: 수동 확인**

`npm run tauri dev`, 실제 Seafile 계정으로 로그인. 개발자 도구 콘솔에서 `(await import('/src/features/sync/links.ts')).addLink({...})`로 연결 하나를 직접 넣고(PC 테스트 폴더 ↔ 미리 만든 드라이브 폴더) 앱을 새로고침.
Expected: (a) 테스트 폴더에 `a.txt`를 저장하면 몇 초 안에 업로드 패널에 보이고 드라이브에 생긴다. (b) `a.txt`를 지우면 드라이브에서도 사라진다. (c) 파일 10개를 만들어 동기화한 뒤 전부 지우면 확인 창이 뜨고, [취소]하면 드라이브에 남는다. (d) 테스트 폴더 이름을 바꾸면 드라이브는 그대로다.

- [ ] **Step 3: 전체 테스트·타입 확인** — Run: `npm test && npx tsc --noEmit` → PASS
- [ ] **Step 4: Commit** — `git commit -m "feat(sync): 동기화 엔진 SyncRoot와 대량 삭제 확인"`

---

### Task 7: 동기화 폴더 추가 흐름과 메뉴

**Files:**
- Create: `src/features/sync/useAddSyncFolder.ts`, `src/features/sync/AddSyncDialog.tsx`
- Modify: `src/storage/session.ts` (+ `session.test.ts`), `src/storage/StorageContext.tsx`, `src/features/shell/MenuBar.tsx` (`MenuActions`), `src/features/shell/TitleBar.tsx`, `src/features/browse/BackgroundContextMenu.tsx` (`BackgroundMenuActions`), `src/features/browse/MainScreen.tsx`

**Interfaces:**
- Consumes: `checkNewLink`, `addLink`, `scanFolder`, `requestRun`, `pickFolder` 방식(`@tauri-apps/plugin-dialog` `open({ directory: true, title: "동기화할 PC 폴더" })`)
- Produces:

```ts
// session.ts
export function isPersistent(stores?: Stores): boolean;   // localStorage에 토큰이 있으면 true
// StorageContext: SessionApi에 makePersistent(): void 추가 (현재 세션을 saveSession(s, { persistent: true })로)
// MenuActions, BackgroundMenuActions 에
addSyncFolder?(): void;   // 데스크톱 앱에서만. readOnly면 끈다
// useAddSyncFolder.ts
export function useAddSyncFolder(loc: Location, lib: Library | undefined, entries: Entry[]): { start(): void; dialog: ReactNode };
```

흐름(`start`):
1. 폴더 선택. 취소면 끝.
2. `scanFolder` → `"NOT_FOUND"`면 toast 아닌 기존 오류 표시 방식으로 "폴더를 읽을 수 없습니다".
3. `getAccount()`로 `quotaLeft = quota === null ? null : quota - usage`. `name`은 경로의 마지막 부분.
4. `checkNewLink` → 거부면 이유를 `AddSyncDialog`에 오류로 보여 주고 [확인]만.
5. `AddSyncDialog` 확인 내용:
   - 제목 "'{name}' 폴더를 동기화할까요?"
   - "{크기}, 파일 {n}개를 드라이브에 올립니다. 남은 용량 {quotaLeft 또는 '제한 없음'}." (`formatSize` 사용)
   - "파일을 고칠 때마다 이전 버전이 남아 시간이 지나면 용량을 더 쓸 수 있습니다."
   - `existing`이면 "같은 이름의 폴더가 이미 있습니다. 기존 폴더에 이어서 연결하면 PC 파일을 올리기만 하고, 드라이브의 파일은 지우지 않습니다." 그리고 버튼 문구 [이어서 연결].
   - 경로가 `\\`로 시작하면 "네트워크 폴더는 변경 알림이 오지 않을 수 있어 반영이 최대 1시간 늦을 수 있습니다."
   - 켜 두기 안내(아래 셋 중 꺼진 것이 있으면 체크박스 하나 "앱을 켜 두는 설정도 함께 켜기", 기본 체크): 자동 실행(`plugin-autostart` `isEnabled`), `closeToTray`, `isPersistent()`. 문구 "앱이 켜져 있을 때만 동기화됩니다." 자동 로그인이 꺼져 있으면 "자동 로그인이 꺼져 있어 PC를 다시 켜면 동기화가 멈춥니다."를 덧붙인다.
   - 버튼 [취소] / [동기화 시작] (또는 [이어서 연결])
6. 확인 → `existing`이 아니면 `storage.mkdir(libId, joinPath(dir, name))` → `addLink({ id: crypto.randomUUID(), account, libId, drivePath, localRoot, paused: false, fresh: existing })` → 켜 두기 체크 시 `autostart.enable()`, `setPrefs({ closeToTray: true })`, `makePersistent()` → `requestRun(id)` → 목록 갱신(`["dir", libId, dir]` 무효화).

메뉴:
- `TitleBar.tsx`: [새 폴더] 아이콘 버튼 바로 뒤에 `IconBtn label="동기화 폴더 추가"`(`m.addSyncFolder`가 있을 때만, `disabled={disabled || m.readOnly}`). 아이콘은 `@tabler/icons-react`에서 고른다.
- `MenuBar.tsx` 파일 메뉴와 `BackgroundContextMenu.tsx`: "폴더 업로드…" 바로 아래 "동기화 폴더 추가…".
- `MainScreen.tsx`: `addSyncFolder: isTauri() ? sync.start : undefined`를 두 곳(`TitleBar menu`, 배경 메뉴)에 넘기고 `sync.dialog`를 렌더.

- [ ] **Step 1: 실패하는 테스트 작성** (`session.test.ts`)

```ts
it("isPersistent reflects where the token is stored", () => {
  const stores = { local: memStorage(), session: memStorage() }; // session.test.ts의 기존 헬퍼
  saveSession(s, { persistent: false }, stores); expect(isPersistent(stores)).toBe(false);
  saveSession(s, { persistent: true }, stores); expect(isPersistent(stores)).toBe(true);
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/storage/session.test.ts` → FAIL
- [ ] **Step 3: 구현** (session → StorageContext → 훅·확인 창 → 메뉴 세 곳 → MainScreen)
- [ ] **Step 4: 통과 확인** — Run: `npm test && npx tsc --noEmit` → PASS
- [ ] **Step 5: 수동 확인** — `npm run tauri dev`. 내 라이브러리에서 [동기화 폴더 추가] → PC 테스트 폴더 선택 → 확인 창에 크기·파일 수·남은 용량 → [동기화 시작] → 같은 이름 폴더가 생기고 파일이 올라간다. 같은 PC 폴더를 다시 추가하면 "이미 동기화 중인 PC 폴더와 겹칩니다". 같은 이름 폴더가 있는 위치에서 추가하면 [이어서 연결]. 웹(`npm run dev`)에서는 버튼과 메뉴 항목이 없다.
- [ ] **Step 6: Commit** — `git commit -m "feat(sync): 동기화 폴더 추가 흐름과 메뉴"`

---

### Task 8: 동기화 폴더 안 변경 경고와 연결 따라가기

**Files:**
- Create: `src/features/sync/useSyncGuard.ts`, `src/features/sync/SyncWarningDialog.tsx`
- Modify: `src/features/browse/MainScreen.tsx`, `src/features/browse/useEntryActions.ts`

**Interfaces:**
- Consumes: `useLinks`, `findLink`, `followMove`, `updateLink`
- Produces:

```ts
// useSyncGuard.ts
export type GuardKind = "change" | "removeRoot";
/** 경고가 필요 없으면 바로 true. 필요하면 확인 창을 띄우고 [계속]이면 true */
export function useSyncGuard(libId: string | null): { guard(paths: string[], kind?: GuardKind): Promise<boolean>; dialog: ReactNode };
```

- `guard(paths)`: `paths` 중 하나라도 `findLink`에 걸리면 경고. 단, 경로가 연결 폴더 **자체**이고 `kind`가 `"change"`(이름 변경·이동)면 경고하지 않는다(연결이 따라감). `kind === "removeRoot"`는 삭제 대상에 연결 폴더 자체가 있을 때 쓴다.
- 문구(`"change"`): 제목 "동기화 중인 폴더입니다", 설명 "이 폴더는 PC의 `{localRoot}` 폴더와 동기화 중입니다. 여기서 바꾼 내용은 PC에 반영되지 않고, PC에서 같은 파일을 저장하면 덮어써집니다." [취소] [계속].
- 문구(`"removeRoot"`): 설명 "동기화 연결이 끊깁니다. 연결만 해제하려면 우클릭 → 동기화 해제를 쓰세요." [취소] [삭제].

MainScreen 연결 지점(각각 `await guard(...)`가 false면 중단):
- 업로드 `onFiles`: `[loc.path]`
- 새 폴더 `onCreateFolder`: `[loc.path]`
- 이름 변경 `onRenameSubmit`: `[entry.path]`
- 삭제: `DeleteDialog`를 열기 전에 — 대상에 연결 폴더 자체가 있으면 `"removeRoot"`, 아니면 대상 경로들로 `"change"`
- 끌어서 옮기기: `[loc.path, dstDir]`와 옮기는 항목들

`useEntryActions.ts`: `rename`·`move` 성공 시 옮겨진 각 경로(`oldPath` → `newPath`)에 대해 `followMove`를 적용하고 바뀐 연결을 `updateLink`. 이 훅이 `useLinks`를 쓰려면 계정 키가 필요하므로, `followMove`를 저장소 전체 연결에 적용하는 `followMoveAll(libId, oldPath, newPath)`를 `links.ts`에 추가해 쓴다(같은 libId·경로면 계정이 달라도 같은 드라이브 폴더다).

- [ ] **Step 1: 실패하는 테스트 작성** (`links.test.ts`에 추가)

```ts
it("followMoveAll updates stored links", () => {
  addLink(L({ id: "x", drivePath: "/a/기획안" }));
  followMoveAll("lib", "/a", "/b");
  expect(getLinks("a").find((l) => l.id === "x")?.drivePath).toBe("/b/기획안");
});
```
- [ ] **Step 2: 실패 확인** — `npx vitest run src/features/sync/links.test.ts` → FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — `npm test && npx tsc --noEmit` → PASS
- [ ] **Step 5: 수동 확인** — 동기화 폴더 안에서 업로드·새 폴더·이름 변경·삭제·끌어서 옮기기를 각각 시도 → 경고 창, [취소]하면 아무 일도 없음. 동기화 폴더 자체 이름 변경 → 경고 없이 바뀌고, 그 뒤 PC에서 파일을 저장하면 새 이름 폴더로 올라간다. 동기화 폴더 자체 삭제 → "동기화 연결이 끊깁니다" 문구.
- [ ] **Step 6: Commit** — `git commit -m "feat(sync): 동기화 폴더 안 변경 경고, 이름 변경·이동 따라가기"`

---

### Task 9: 표시와 관리 메뉴

**Files:**
- Create: `src/features/sync/SyncBadge.tsx`, `src/features/sync/SyncDetails.tsx`
- Modify: `src/features/browse/FileList.tsx`, `src/features/browse/IconGrid.tsx`, `src/features/browse/DetailsPanel.tsx`, `src/features/browse/ContextMenu.tsx` (`EntryMenuActions`), `src/features/browse/MainScreen.tsx`

**Interfaces:**
- Consumes: `useLinks`, `useLinkState`, `useAllLinkStates`, `requestRun`, `updateLink`, `removeLink`, `deleteBaseline`, `unwatchFolder`
- Produces:

```ts
// SyncBadge.tsx
export function SyncBadge({ status, className }: { status: SyncStatus; className?: string }): JSX.Element;
// FileList/IconGrid props (sharedPaths와 같은 방식)
syncLinks?: Map<string, SyncLink>;   // drivePath → link, 지금 저장소의 연결만
// EntryMenuActions
syncMenu?(entry: Entry): { link: SyncLink } | undefined;   // 연결 폴더면 관리 항목을 붙인다
```

- 목록·아이콘 보기: `syncLinks.get(e.path)`가 있으면 폴더 아이콘에 `SyncBadge`를 겹친다. 오류 상태(`localMissing`·`driveMissing`·`error`·`needsConfirm`)는 다른 색. 모양·색은 빌더가 정한다.
- 상세 패널(폴더 하나 선택, 연결 폴더일 때): `SyncDetails` — "PC 폴더 {localRoot}", 상태 문구, "마지막 동기화 {formatDate}". 상태 문구:
  - idle "동기화됨", syncing "올리는 중 {pending}개", paused "일시정지됨", needsConfirm "확인 필요: 파일 {deleteCount}개 삭제 대기", localMissing "PC 폴더를 찾을 수 없음", driveMissing "드라이브 폴더를 찾을 수 없음", error "오류: {error}"
- 상태 표시줄: 기존 `note`가 없을 때, 올리는 중인 연결이 있으면 "동기화 중 {합계}개", 오류 상태 연결이 있으면 "동기화 오류 {n}건". 누르면 첫 오류 연결 폴더로 이동(`StatusBar`에 `onNoteClick?` prop 추가).
- 우클릭 메뉴(연결 폴더): 구분선 뒤에
  - "PC 폴더 열기" → `revealItemInDir(localRoot)`
  - "지금 동기화" → `requestRun(id)` (일시정지면 끈다)
  - "일시정지" / "다시 시작" → `updateLink(id, { paused })`; 다시 시작은 `requestRun(id)`도 부른다(대량 삭제 확인을 다시 거친다)
  - "동기화 해제" → 확인 창 "동기화를 해제할까요?" / "드라이브 폴더와 파일은 그대로 남고 일반 폴더가 됩니다." [취소] [해제] → `unwatchFolder`, `deleteBaseline`, `removeLink`

- [ ] **Step 1: 구현** (화면 표시라 단위 테스트 없음)
- [ ] **Step 2: 확인** — `npm test && npx tsc --noEmit && npm run lint` → PASS
- [ ] **Step 3: 수동 확인** — 동기화 폴더에 표시가 보이고(목록·아이콘 보기), 상세 패널에 PC 경로·상태·마지막 시각. PC 폴더 이름을 바꾸면 표시 색이 바뀌고 상세 패널에 "PC 폴더를 찾을 수 없음". 일시정지 중에는 PC 저장이 올라가지 않고, 다시 시작하면 올라간다. 동기화 해제 후 표시가 사라지고 파일은 남는다.
- [ ] **Step 4: Commit** — `git commit -m "feat(sync): 동기화 폴더 표시와 관리 메뉴"`

---

### Task 10: 전체 점검

- [ ] **Step 1: 자동 검사** — Run: `npm test && npx tsc --noEmit && npm run lint && (cd src-tauri && cargo test && cargo clippy -- -D warnings)` → 모두 PASS
- [ ] **Step 2: 숨김 실행 실제 확인** — 연결 하나를 만든 뒤 앱 종료 → PC 폴더에 파일 추가 → `npm run tauri dev -- -- --autostart`(창 숨김) → 몇 초 안에 드라이브에 올라간다. 창을 숨긴 채 PC 폴더에서 파일 10개를 모두 지우면 확인 창이 뜨지 않고, 트레이로 창을 열면 그때 뜬다.
- [ ] **Step 3: Word 저장 확인 (Windows)** — 동기화 폴더의 `.docx`를 Word로 열고 고쳐서 저장 → `~$` 잠금 파일과 임시 파일은 드라이브에 없고, 원본만 한 번 갱신된다(드라이브 파일 히스토리에 새 버전).
- [ ] **Step 4: 줄끝 확인** — Run: `git ls-files --eol src/features/sync src-tauri/src/syncfs.rs` → 새 파일 모두 `w/crlf`
