import type { DownloadQueue } from "@/features/download/downloadQueue";
import { previewKind } from "@/features/preview/previewKind";
import { searchEntries } from "@/features/search/searchIndex";
import type { IndexedEntry } from "@/features/search/useSearchIndex";
import type { UploadQueue } from "@/features/upload/uploadQueue";
import { formatDate, formatSize } from "@/lib/format";
import { baseName, joinPath, parentPath } from "@/storage/path";
import { StorageError, type Entry, type Library, type StorageProvider, type UploadTask } from "@/storage/StorageProvider";
import { blockedLocalPath, plainFileName } from "./localPath";
import { waitSettled } from "./waitSettled";

export interface LocalFile {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

/** 도구가 쓰는 앱 기능. 로그인된 화면이 채운다(McpBridge) */
export interface ToolCtx {
  storage: StorageProvider;
  uploads: UploadQueue;
  downloads: DownloadQueue;
  /** 검색할 때 받아 온다(받아 둔 게 있으면 그대로) */
  searchIndex(): Promise<IndexedEntry[]>;
  /** 로컬 파일을 읽어 File로(이름 = 경로의 마지막 부분) */
  readLocalFile(path: string): Promise<File>;
  /** dir 안에서 name과 겹치지 않는 경로 */
  freePath(dir: string, name: string): Promise<string>;
  /** 설정의 다운로드 폴더, 없으면 OS 다운로드 폴더 */
  defaultDownloadDir(): Promise<string>;
  /** Claude 전용 받기 폴더(다운로드 폴더 아래 'U-Drive 작업'). 사용자가 앱에서 받는 파일과 섞이지 않게 한다 */
  workDir(): Promise<string>;
  recentFiles(dir: string, limit: number): Promise<LocalFile[]>;
  /** 새 파일로 쓴다(있는 파일은 덮어쓰지 않는다) */
  writeLocalFile(path: string, data: Uint8Array): Promise<void>;
  /** 심볼릭 링크를 따라간 실제 경로(없는 경로면 그대로) */
  realPath(path: string): Promise<string>;
}

/** Claude가 넘긴 PC 경로가 숨김·시스템 폴더면 막는다. 링크로 돌아가지 못하게 실제 경로도 본다 */
async function allowLocal(ctx: ToolCtx, path: string): Promise<void> {
  const reason = blockedLocalPath(path) ?? blockedLocalPath(await ctx.realPath(path));
  if (reason) throw new Error(reason);
}

/** Claude가 준 파일 이름. 경로가 섞여 있으면 이름만 */
function fileNameArg(args: Record<string, unknown>): string {
  const name = plainFileName(arg<string>(args, "name", isStr));
  if (!name) throw new Error("파일 이름이 올바르지 않습니다");
  return name;
}

export interface ToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

const str = (description: string) => ({ type: "string", description });
const LIBRARY = str("저장소 id (list_libraries의 id)");
const MY_LIBRARY = str("저장소 id. 생략하면 '내 저장소'의 저장소(하나뿐일 때). 여럿이면 후보를 알려준다");
const MINE = "내 저장소";
const SCOPE = {
  type: "string",
  enum: ["mine", "all"],
  description: "mine(기본) = 사용자 본인 저장소('내 저장소')만. all = 다른 사람이 공유한 저장소까지. 사용자가 공유받은 것·팀·다른 사람 것을 말할 때만 all",
};

export const TOOLS: { name: string; description: string; inputSchema: object }[] = [
  {
    name: "list_libraries",
    description:
      "U-Drive(유드라이브·udrive·회사 드라이브)의 저장소 목록. U-Drive는 사용자 PC의 U-Drive 앱에 로그인된 드라이브로, 구글 드라이브가 아니다. 사용자가 U-Drive·유드라이브·회사 드라이브라고 하면 이 도구들을 쓰고, 그냥 '드라이브'라고만 했는데 다른 드라이브 도구도 있으면 어느 쪽인지 먼저 묻는다. 기본은 사용자 본인 저장소('내 저장소')만 돌려준다. '내 드라이브'·'내 유드라이브'는 본인 저장소만 뜻하므로 공유받은 저장소는 보지 않는다. 암호화·읽기 전용 여부도 알려준다.",
    inputSchema: { type: "object", properties: { scope: SCOPE } },
  },
  {
    name: "list_dir",
    description: "저장소 안 폴더의 파일·폴더 목록(크기·수정한 날짜는 읽기 좋은 형식). 올릴 위치를 제안하기 전에 기존 구조를 볼 때 쓴다.",
    inputSchema: {
      type: "object",
      properties: { library: MY_LIBRARY, path: str("'/'로 시작하는 폴더 경로. 루트는 '/'") },
      required: ["path"],
    },
  },
  {
    name: "preview",
    description:
      "드라이브 파일을 PC에 저장하지 않고 바로 본다. 사용자가 파일을 보여 달라·열어 달라·내용이 뭐냐고 하면 download 대신 이걸 쓴다. 이미지(긴 변 1024px 축소본)와 텍스트 파일(md·txt·json·코드 등)만 된다. 그 밖의 형식이거나, 원본이 필요하거나, 파일로 작업(수정·분석)해야 하면 download를 쓴다.",
    inputSchema: { type: "object", properties: { library: MY_LIBRARY, path: str("파일 경로('/'로 시작)") }, required: ["path"] },
  },
  {
    name: "search",
    description: "이름으로 파일·폴더를 찾는다(최대 20개). 기본은 사용자 본인 저장소('내 저장소')에서만 찾는다.",
    inputSchema: { type: "object", properties: { query: str("찾을 이름(일부)"), scope: SCOPE }, required: ["query"] },
  },
  {
    name: "upload_file",
    description:
      "사용자 PC의 파일을 U-Drive 폴더에 올린다. 사용자가 올려 달라고 할 때만 쓴다(문서를 다 썼다고 먼저 묻지 않는다). 올리기 전에 list_libraries·list_dir로 '내 저장소'의 폴더 구조를 보고 올릴 폴더를 제안해 사용자 확인을 받는다. 폴더가 없으면 만든다. 같은 이름이 있으면 아무것도 올리지 않고 conflicts를 돌려준다. 그러면 덮어쓸지 묻고 동의할 때만 overwrite: true로 다시 호출한다.",
    inputSchema: {
      type: "object",
      properties: {
        local_paths: { type: "array", items: { type: "string" }, description: "올릴 파일의 절대 경로들" },
        library: LIBRARY,
        dir: str("올릴 폴더 경로('/'로 시작)"),
        overwrite: { type: "boolean", description: "같은 이름 파일을 덮어쓴다. 사용자가 동의했을 때만 true" },
      },
      required: ["local_paths", "library", "dir"],
    },
  },
  {
    name: "upload_text",
    description: "텍스트 내용을 UTF-8 파일로 만들어 U-Drive 폴더에 올린다(채팅에서 쓴 md·txt 문서용). 규칙은 upload_file과 같다.",
    inputSchema: {
      type: "object",
      properties: {
        name: str("파일 이름(확장자 포함)"),
        content: str("파일 내용"),
        library: LIBRARY,
        dir: str("올릴 폴더 경로('/'로 시작)"),
        overwrite: { type: "boolean", description: "같은 이름 파일을 덮어쓴다. 사용자가 동의했을 때만 true" },
      },
      required: ["name", "content", "library", "dir"],
    },
  },
  {
    name: "upload_base64",
    description:
      "Claude 작업 공간(클라우드)에 있는 파일(채팅에서 만든 docx·pdf·이미지 등)을 사용자 PC의 다운로드 폴더에 내려받은 뒤 U-Drive 폴더에 올린다. 사용자가 작업 공간의 파일을 U-Drive(유드라이브)에 올려 달라고 하면 사용자에게 다운로드를 부탁하지 말고 이 도구를 쓴다. 작업 공간에서 파일의 base64와 sha256을 구해 그대로 넘긴다. sha256이 맞지 않으면 아무것도 하지 않는다. 작업 공간에 사용자 PC 폴더가 연결돼 있으면 이 도구 대신 그 폴더에 저장하고 upload_file로 올려도 된다. 반드시 사용자 확인을 받은 뒤 호출한다.",
    inputSchema: {
      type: "object",
      properties: {
        name: str("파일 이름(확장자 포함)"),
        base64: str("파일 내용의 base64"),
        sha256: str("원본 파일의 sha256(16진수). 옮기다 깨지지 않았는지 확인한다"),
        library: LIBRARY,
        dir: str("올릴 폴더 경로('/'로 시작)"),
        overwrite: { type: "boolean", description: "같은 이름 파일을 덮어쓴다. 사용자가 동의했을 때만 true" },
      },
      required: ["name", "base64", "sha256", "library", "dir"],
    },
  },
  {
    name: "download",
    description:
      "드라이브 파일을 사용자 PC에 받는다(폴더는 안 됨). 파일로 작업(수정·분석)하거나 원본이 필요할 때 쓴다. 보여 주기만 하면 preview를 쓴다. 같은 이름이 있으면 번호를 붙여 저장하고, 저장한 절대 경로를 돌려준다.",
    inputSchema: {
      type: "object",
      properties: {
        library: LIBRARY,
        paths: { type: "array", items: { type: "string" }, description: "받을 파일 경로들('/'로 시작)" },
        local_dir: str("저장할 로컬 폴더의 절대 경로. Claude Code면 현재 작업 폴더. 모르면 생략(다운로드 폴더 아래 'U-Drive 작업' 폴더에 저장)"),
      },
      required: ["library", "paths"],
    },
  },
  {
    name: "recent_downloads",
    description: "사용자 다운로드 폴더의 최근 파일(최신순). 채팅에서 만든 파일을 사용자가 받은 뒤 찾아서 올릴 때 쓴다.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "개수(기본 10)" } } },
  },
];

const json = (v: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(v) }] });

/** Claude가 넘기는 폴더 경로를 '/a/b' 꼴로. 빈 문자열은 루트 */
export function normalizeDir(dir: string): string {
  return "/" + dir.split("/").filter(Boolean).join("/");
}

/**
 * 올릴 위치를 정한다. dir이 있으면 그대로(기존 항목과 함께), 없으면 처음 존재하는 상위 폴더 + 나머지 경로.
 * 나머지 경로는 업로드의 relative_path로 넘겨 서버가 중간 폴더를 만든다.
 */
export async function resolveTarget(storage: StorageProvider, libId: string, dir: string): Promise<{ targetDir: string; relativePath?: string; existing: Entry[] }> {
  const missing: string[] = [];
  let cur = normalizeDir(dir);
  for (;;) {
    try {
      const existing = await storage.listDir(libId, cur);
      return missing.length ? { targetDir: cur, relativePath: missing.join("/"), existing: [] } : { targetDir: cur, existing };
    } catch (e) {
      if (!(e instanceof StorageError && e.kind === "notFound") || cur === "/") throw e;
      missing.unshift(baseName(cur));
      cur = parentPath(cur);
    }
  }
}

function arg<T>(args: Record<string, unknown>, key: string, ok: (v: unknown) => boolean): T {
  if (!ok(args[key])) throw new Error(`${key} 값이 필요합니다`);
  return args[key] as T;
}
const isStr = (v: unknown) => typeof v === "string";

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  try {
    return Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("base64 형식이 올바르지 않습니다");
  }
}
const isStrs = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(isStr);

/** scope가 all이 아니면 사용자 본인 저장소만. '내 유드라이브'에 공유받은 저장소가 섞이지 않게 한다 */
async function scopedLibraries(ctx: ToolCtx, args: Record<string, unknown>): Promise<Library[]> {
  const libs = await ctx.storage.listLibraries();
  return args.scope === "all" ? libs : libs.filter((l) => l.section === MINE);
}

/** library를 생략했을 때: '내 저장소'의 저장소가 하나면 그것, 아니면 후보를 담아 실패한다 */
async function myLibraryId(ctx: ToolCtx): Promise<string> {
  const mine = (await ctx.storage.listLibraries()).filter((l) => l.section === MINE && !l.encrypted);
  if (mine.length === 1) return mine[0].id;
  throw new Error(`library를 지정하세요. 내 저장소: ${JSON.stringify(mine.map((l) => ({ id: l.id, name: l.name })))}`);
}

async function findLibrary(ctx: ToolCtx, id: string, use: "upload" | "download"): Promise<Library> {
  const lib = (await ctx.storage.listLibraries()).find((l) => l.id === id);
  if (!lib) throw new Error(`저장소를 찾을 수 없습니다: ${id}`);
  if (lib.encrypted) throw new Error(use === "upload" ? "암호화 저장소에는 올릴 수 없습니다" : "암호화 저장소에서는 받을 수 없습니다");
  if (use === "upload" && lib.readOnly) throw new Error("읽기 전용 저장소입니다");
  return lib;
}

/** 충돌을 먼저 보고(하나라도 있으면 전부 멈춤) 파일은 그다음에 읽는다. 업로드 큐에 넣어 앱 패널에도 뜬다 */
async function upload(ctx: ToolCtx, libId: string, dir: string, names: string[], load: () => Promise<File[]>, overwrite: boolean, extra: () => object = () => ({})): Promise<ToolResult> {
  await findLibrary(ctx, libId, "upload");
  const { targetDir, relativePath, existing } = await resolveTarget(ctx.storage, libId, dir);
  const taken = new Set(existing.map((e) => e.name));
  const conflicts = names.filter((n) => taken.has(n));
  if (conflicts.length && !overwrite) {
    return json({ uploaded: [], conflicts, message: "같은 이름의 파일이 있습니다. 사용자에게 덮어쓸지 물어본 뒤 overwrite: true로 다시 호출하세요." });
  }
  const files = await load();
  const tasks: UploadTask[] = files.map((file) => (relativePath ? { file, targetDir, relativePath } : { file, targetDir }));
  const items = await waitSettled(ctx.uploads, ctx.uploads.add(libId, tasks), (s) => s === "done" || s === "failed" || s === "cancelled");
  const dirPath = normalizeDir(dir);
  return json({
    uploaded: items.filter((i) => i.status === "done").map((i) => ({ name: i.task.file.name, path: joinPath(dirPath, i.task.file.name) })),
    failed: items.filter((i) => i.status !== "done").map((i) => ({ name: i.task.file.name, error: i.error ?? "취소됨" })),
    ...extra(),
  });
}

async function findFile(ctx: ToolCtx, libId: string, p: string): Promise<Entry> {
  const path = normalizeDir(p);
  const e = (await ctx.storage.listDir(libId, parentPath(path))).find((x) => x.name === baseName(path));
  if (!e) throw new Error(`파일을 찾을 수 없습니다: ${path}`);
  if (e.type !== "file") throw new Error(`파일만 받을 수 있습니다: ${path}`);
  return e;
}

async function download(ctx: ToolCtx, libId: string, paths: string[], localDir?: string): Promise<ToolResult> {
  await findLibrary(ctx, libId, "download");
  const entries = await Promise.all(paths.map((p) => findFile(ctx, libId, p)));
  if (localDir) await allowLocal(ctx, localDir);
  const dir = localDir ?? (await ctx.workDir());
  // ponytail: 디스크에 있는 이름만 피한다(downloadEntries와 같은 한계). 같은 이름 둘을 한 번에 받으면 겹칠 수 있음
  const targets = await Promise.all(entries.map((e) => ctx.freePath(dir, e.name)));
  const ids = ctx.downloads.add(entries.map((e, i) => ({ name: e.name, size: e.size, url: () => ctx.storage.downloadUrl(libId, e.path), path: targets[i] })));
  const items = await waitSettled(ctx.downloads, ids, (s) => s === "done" || s === "failed");
  return json({
    saved: items.filter((i) => i.status === "done").map((i) => i.job.path),
    failed: items.flatMap((i, n) => (i.status === "done" ? [] : [{ path: entries[n].path, error: i.error ?? "실패" }])),
  });
}

const PREVIEW_IMAGE_SIZE = 1024;
/** 앱 미리보기와 같은 상한. 이보다 큰 텍스트는 download로 받게 한다 */
const PREVIEW_TEXT_LIMIT = 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 이미지는 서버 축소본, 텍스트는 내용을 그대로 돌려준다. PC에는 아무것도 쓰지 않는다 */
async function preview(ctx: ToolCtx, libId: string, path: string): Promise<ToolResult> {
  await findLibrary(ctx, libId, "download");
  const e = await findFile(ctx, libId, path);
  // svg는 Claude가 이미지로 받지 않아 텍스트로 준다
  const kind = /\.svg$/i.test(e.name) ? "text" : previewKind(e.name);
  if (kind === "image") {
    const blob = await ctx.storage.thumbnail(libId, e.path, PREVIEW_IMAGE_SIZE);
    return { content: [{ type: "image", data: toBase64(new Uint8Array(await blob.arrayBuffer())), mimeType: blob.type || "image/png" }] };
  }
  if (kind !== "text") throw new Error(`미리 볼 수 없는 형식입니다: ${e.name}. 내용이 필요하면 download로 받으세요.`);
  if (e.size > PREVIEW_TEXT_LIMIT) throw new Error(`1MB가 넘는 텍스트는 미리 볼 수 없습니다: ${e.name}. download로 받으세요.`);
  return { content: [{ type: "text", text: await ctx.storage.readText(libId, e.path) }] };
}

/** 도구 실행. 실패는 isError 결과로 돌려준다. 로그인 만료(401)만 그대로 던져 호출하는 쪽이 로그인 안내로 바꾼다 */
export async function callTool(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  try {
    return await run(name, args, ctx);
  } catch (e) {
    if (e instanceof StorageError && e.kind === "unauthorized") throw e;
    return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

async function run(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  switch (name) {
    case "list_libraries":
      return json((await scopedLibraries(ctx, args)).map((l) => ({ id: l.id, name: l.name, section: l.section, readOnly: !!l.readOnly, encrypted: l.encrypted })));
    case "list_dir": {
      const libId = isStr(args.library) ? (args.library as string) : await myLibraryId(ctx);
      const entries = await ctx.storage.listDir(libId, normalizeDir(arg(args, "path", isStr)));
      // Claude가 숫자를 날짜·크기로 바꾸느라 코드를 돌리지 않게 읽기 좋은 형식으로 준다
      return json(entries.map((e) => ({ name: e.name, type: e.type, size: e.type === "file" ? formatSize(e.size) : undefined, modified: formatDate(e.mtime) })));
    }
    case "preview":
      return preview(ctx, isStr(args.library) ? (args.library as string) : await myLibraryId(ctx), arg(args, "path", isStr));
    case "search": {
      const entries = await ctx.searchIndex();
      const libNames = new Map((await scopedLibraries(ctx, args)).map((l) => [l.id, l.name]));
      const results = searchEntries(entries.filter((e) => libNames.has(e.libId)), arg(args, "query", isStr), 20).map((e) => ({ library: e.libId, libraryName: libNames.get(e.libId) ?? e.libId, path: e.path, type: e.type, size: formatSize(e.size) }));
      const note = !results.length && args.scope !== "all" ? "내 저장소에는 없습니다. 공유받은 저장소까지 찾을지 사용자에게 물어본 뒤 scope: all로 다시 찾으세요." : undefined;
      return json({ results, note });
    }
    case "upload_file": {
      const paths = arg<string[]>(args, "local_paths", isStrs);
      for (const p of paths) await allowLocal(ctx, p);
      const names = paths.map((p) => p.split(/[\\/]/).pop()!);
      return upload(ctx, arg(args, "library", isStr), arg(args, "dir", isStr), names, () => Promise.all(paths.map((p) => ctx.readLocalFile(p))), args.overwrite === true);
    }
    case "upload_text": {
      const fileName = fileNameArg(args);
      const content = arg<string>(args, "content", isStr);
      return upload(ctx, arg(args, "library", isStr), arg(args, "dir", isStr), [fileName], async () => [new File([content], fileName, { type: "text/plain" })], args.overwrite === true);
    }
    case "upload_base64": {
      const fileName = fileNameArg(args);
      const bytes = decodeBase64(arg(args, "base64", isStr));
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
      if (hash !== arg<string>(args, "sha256", isStr).trim().toLowerCase()) throw new Error("sha256이 맞지 않아 올리지 않았습니다. base64를 다시 구해 시도하세요.");
      // 사용자가 직접 받은 것처럼 먼저 PC 다운로드 폴더에 저장하고, 그 파일을 올린다(충돌이 있으면 저장도 하지 않는다)
      let savedTo: string | undefined;
      const save = async () => {
        savedTo = await ctx.freePath(await ctx.defaultDownloadDir(), fileName);
        await ctx.writeLocalFile(savedTo, bytes);
        return [new File([bytes], fileName)];
      };
      return upload(ctx, arg(args, "library", isStr), arg(args, "dir", isStr), [fileName], save, args.overwrite === true, () => ({ savedTo }));
    }
    case "download":
      return download(ctx, arg(args, "library", isStr), arg(args, "paths", isStrs), isStr(args.local_dir) ? (args.local_dir as string) : undefined);
    case "recent_downloads":
      return json(
        (await ctx.recentFiles(await ctx.defaultDownloadDir(), typeof args.limit === "number" ? args.limit : 10)).map((f) => ({ name: f.name, path: f.path, size: formatSize(f.size), modified: formatDate(f.mtime) })),
      );
    default:
      throw new Error(`알 수 없는 도구: ${name}`);
  }
}
