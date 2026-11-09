import type { Account, Entry, Library, StorageProvider, TrashEntry, UploadTask } from "../StorageProvider";
import { StorageError } from "../StorageProvider";
import { baseName, joinPath, parentPath } from "../path";

/** 개발·화면 확인용 인메모리 구현체. 서버 없이 UI를 돌려 본다. */
export class MockProvider implements StorageProvider {
  token: string | null;
  private libs: Library[] = [
    { id: "docs", name: "문서", size: 1_200_000, mtime: 1_760_000_000, encrypted: false, section: "내 저장소" },
    { id: "photos", name: "사진", size: 9_800_000_000, mtime: 1_760_100_000, encrypted: false, section: "내 저장소" },
    { id: "vault", name: "금고", size: 0, mtime: 1_760_000_000, encrypted: true, section: "내 저장소" },
    { id: "family", name: "집-공유", size: 0, mtime: 1_760_000_000, encrypted: false, section: "나에게 공유됨", readOnly: true },
  ];
  private tree = new Map<string, Entry[]>();
  private trash = new Map<string, TrashEntry[]>();
  /** 내용이 바뀔 때마다 증가. headCommitId 흉내 */
  private rev = 0;

  constructor(initialToken: string | null) {
    this.token = initialToken;
    const now = 1_761_400_000;
    this.set("docs", "/", [
      dir("/회의록", now), dir("/프로젝트", now - 86400), dir("/영수증", now - 400000),
      file("/README.md", 1_024, now), file("/예산.xlsx", 48_000, now - 7200), file("/로고.png", 320_000, now - 86400 * 3),
      file("/계약서.pdf", 2_300_000, now - 86400 * 9), file("/소개.html", 2_048, now - 3600),
    ]);
    this.set("docs", "/회의록", [file("/회의록/2026-10-20.md", 4_000, now), file("/회의록/2026-10-13.md", 3_500, now - 600000)]);
    this.set("docs", "/프로젝트", []);
    this.set("docs", "/영수증", [file("/영수증/10월.jpg", 1_500_000, now)]);
    this.set("photos", "/", [dir("/2025", now), dir("/2026", now), file("/IMG_0001.jpg", 3_355_443, now)]);
    this.set("photos", "/2025", []);
    this.set("photos", "/2026", [file("/2026/IMG_0100.jpg", 4_000_000, now)]);
    this.set("family", "/", []);
  }

  private key(libId: string, path: string) {
    return `${libId}:${path}`;
  }
  private set(libId: string, path: string, entries: Entry[]) {
    this.tree.set(this.key(libId, path), entries);
  }
  private get(libId: string, path: string): Entry[] {
    const e = this.tree.get(this.key(libId, path));
    if (!e) throw new StorageError("notFound", path, 404);
    return e;
  }

  async login(username: string): Promise<void> {
    this.token = `mock-${username}`;
  }
  async logout(): Promise<void> {
    this.token = null;
  }
  isLoggedIn(): boolean {
    return this.token !== null;
  }
  async listGroups(): Promise<string[]> {
    return ["디자인팀", "집"];
  }
  async getAccount(): Promise<Account> {
    await delay(150);
    const usage = [...this.tree.values()].flat().reduce((a, e) => a + e.size, 0) + 12_300_000_000;
    return { name: "김찬기", email: "me@example.com", usage, quota: 50 * 1024 ** 3 };
  }
  async listLibraries(): Promise<Library[]> {
    await delay(200);
    return this.libs.map((l) => ({ ...l, headCommitId: `${l.id}-${this.rev}` }));
  }
  async renameLibrary(libId: string, newName: string): Promise<void> {
    await delay(150);
    this.libs = this.libs.map((l) => (l.id === libId ? { ...l, name: newName } : l));
  }
  async starLibrary(libId: string, starred: boolean): Promise<void> {
    await delay(100);
    this.libs = this.libs.map((l) => (l.id === libId ? { ...l, starred } : l));
  }
  async listDir(libId: string, path: string): Promise<Entry[]> {
    await delay(200);
    return [...this.get(libId, path)];
  }
  async listTree(libId: string): Promise<Entry[]> {
    await delay(300);
    return [...this.tree.entries()].filter(([k]) => k.startsWith(`${libId}:`)).flatMap(([, v]) => v);
  }

  async upload(libId: string, task: UploadTask, onProgress: (sent: number, total: number) => void, signal?: AbortSignal): Promise<void> {
    const total = task.file.size || 1;
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      await delay(100);
      onProgress(Math.round((total * i) / steps), total);
    }
    const dirPath = task.relativePath ? joinPath(task.targetDir, task.relativePath) : task.targetDir;
    this.ensureDir(libId, dirPath);
    const list = this.get(libId, dirPath).filter((e) => e.name !== task.file.name);
    list.push(file(joinPath(dirPath, task.file.name), task.file.size, Date.now() / 1000));
    this.set(libId, dirPath, list);
    this.rev++;
  }

  private ensureDir(libId: string, path: string) {
    if (path === "/" || this.tree.has(this.key(libId, path))) return;
    const parent = parentPath(path);
    this.ensureDir(libId, parent);
    this.set(libId, path, []);
    const siblings = this.get(libId, parent);
    if (!siblings.some((e) => e.path === path)) siblings.push(dir(path, Date.now() / 1000));
  }

  async downloadUrl(_libId: string, path: string): Promise<string> {
    return `data:text/plain;charset=utf-8,${encodeURIComponent(`mock file ${path}`)}`;
  }
  async previewUrl(libId: string, path: string): Promise<string> {
    // 이미지 뷰어 확인용: 이미지는 경로마다 다른 색의 1600×1000 그림
    if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(path)) return this.downloadUrl(libId, path);
    const hue = [...path].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="100%" height="100%" fill="hsl(${hue} 55% 60%)"/><circle cx="1150" cy="300" r="140" fill="hsl(${hue} 70% 85%)"/><path d="M0 1000 L500 450 L850 800 L1150 550 L1600 1000Z" fill="hsl(${hue} 45% 35%)"/></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  async readText(_libId: string, path: string): Promise<string> {
    // HTML 미리보기 확인용: 스타일·링크와 함께, 막혀야 하는 스크립트·폼을 넣어 둔다
    if (/\.html?$/i.test(path))
      return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui;margin:40px;color:#222}h1{color:#0a63c9}.card{border:1px solid #ddd;border-radius:8px;padding:16px}</style></head>
<body><h1>${baseName(path)}</h1><div class="card"><p>HTML 미리보기 견본입니다. <a href="https://example.com">외부 링크</a></p>
<form action="https://example.com"><input name="q" placeholder="폼(전송 막힘)"><button>보내기</button></form></div>
<p id="js">스크립트가 막히면 이 문장이 그대로 보입니다.</p><img src="https://example.com/pixel.png" alt="외부 이미지(차단)"><script>document.getElementById("js").textContent = "스크립트가 실행됨!";</script></body></html>`;
    if (!/\.(md|markdown)$/i.test(path)) return `# ${baseName(path)}\n\nmock 내용입니다.`;
    // 마크다운 미리보기 확인용: 제목·목록·표·체크리스트·코드·인용·링크
    return [
      `# ${baseName(path)}`,
      "",
      "팀 공용 드라이브 사용 안내입니다. **굵게**, *기울임*, ~~취소선~~, `인라인 코드`를 씁니다.",
      "",
      "## 폴더 규칙",
      "",
      "1. 프로젝트마다 폴더를 하나 만든다",
      "2. 회의록은 `회의록/날짜.md` 로 저장한다",
      "   - 날짜는 `YYYY-MM-DD`",
      "   - 참석자를 맨 위에 적는다",
      "",
      "## 할 일",
      "",
      "- [x] 드라이브 정리",
      "- [ ] 공유 링크 만료일 확인",
      "- [ ] 휴지통 비우기",
      "",
      "## 용량",
      "",
      "| 저장소 | 사용량 | 비고 |",
      "| --- | ---: | --- |",
      "| 문서 | 1.2 MB | 공용 |",
      "| 사진 | 9.8 GB | 개인 |",
      "",
      "> 큰 파일은 끌어다 놓으면 나눠서 올라갑니다.",
      "",
      "```ts",
      "const total = files.reduce((a, f) => a + f.size, 0);",
      "console.log(formatSize(total));",
      "```",
      "",
      "---",
      "",
      "마크다운 문법은 [Markdown Guide](https://www.markdownguide.org/)를 참고하세요.",
    ].join("\n");
  }
  async thumbnail(_libId: string, path: string, size: number): Promise<Blob> {
    await delay(150);
    // 경로마다 다른 색의 가로 사진 모양
    const hue = [...path].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${Math.round(size * 0.75)}"><rect width="100%" height="100%" fill="hsl(${hue} 60% 65%)"/></svg>`;
    return new Blob([svg], { type: "image/svg+xml" });
  }
  async mkdir(libId: string, path: string): Promise<void> {
    await delay(150);
    this.ensureDir(libId, path);
    this.rev++;
  }
  async rename(libId: string, path: string, newName: string, _type: "file" | "dir"): Promise<void> {
    await delay(150);
    const parent = parentPath(path);
    this.set(
      libId,
      parent,
      this.get(libId, parent).map((e) => (e.path === path ? { ...e, name: newName, path: joinPath(parent, newName) } : e)),
    );
    this.rev++;
  }
  async remove(libId: string, path: string): Promise<void> {
    await delay(150);
    const parent = parentPath(path);
    const gone = this.get(libId, parent).find((e) => e.path === path);
    this.set(libId, parent, this.get(libId, parent).filter((e) => e.path !== path));
    if (gone) this.trash.set(libId, [{ name: gone.name, type: gone.type, size: gone.size, parentDir: parent, deletedAt: Date.now() / 1000, commitId: `c${Date.now()}` }, ...(this.trash.get(libId) ?? [])]);
    this.rev++;
  }
  async move(libId: string, srcDir: string, names: string[], dstDir: string): Promise<void> {
    await delay(150);
    const moving = this.get(libId, srcDir).filter((e) => names.includes(e.name));
    this.set(libId, srcDir, this.get(libId, srcDir).filter((e) => !names.includes(e.name)));
    this.set(libId, dstDir, [...this.get(libId, dstDir), ...moving.map((e) => ({ ...e, path: joinPath(dstDir, e.name) }))]);
    // 옮긴 폴더 아래 목록들의 키·경로를 새 위치로
    const rebase = (p: string, from: string, to: string) => (p === from || p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    for (const e of moving.filter((m) => m.type === "dir")) {
      const to = joinPath(dstDir, e.name);
      for (const [k, list] of [...this.tree.entries()]) {
        const path = k.slice(libId.length + 1);
        if (!k.startsWith(`${libId}:`) || rebase(path, e.path, to) === path) continue;
        this.tree.delete(k);
        this.set(libId, rebase(path, e.path, to), list.map((x) => ({ ...x, path: rebase(x.path, e.path, to) })));
      }
    }
    this.rev++;
  }
  async listTrash(libId: string): Promise<TrashEntry[]> {
    await delay(200);
    return [...(this.trash.get(libId) ?? [])];
  }
  async restoreTrash(libId: string, e: TrashEntry): Promise<void> {
    await delay(150);
    this.trash.set(libId, (this.trash.get(libId) ?? []).filter((t) => t.commitId !== e.commitId));
    this.ensureDir(libId, e.parentDir);
    const path = joinPath(e.parentDir, e.name);
    const list = this.get(libId, e.parentDir).filter((x) => x.path !== path);
    list.push(e.type === "dir" ? dir(path, e.deletedAt) : file(path, e.size, e.deletedAt));
    this.set(libId, e.parentDir, list);
    if (e.type === "dir" && !this.tree.has(this.key(libId, path))) this.set(libId, path, []);
    this.rev++;
  }
  async emptyTrash(libId: string): Promise<void> {
    await delay(150);
    this.trash.delete(libId);
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = (path: string, mtime: number): Entry => ({ id: path, name: baseName(path), type: "dir", size: 0, mtime, path });
const file = (path: string, size: number, mtime: number): Entry => ({ id: path, name: baseName(path), type: "file", size, mtime, path });
