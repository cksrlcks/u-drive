import { StorageError, type Library, type StorageProvider } from "../StorageProvider";
import type { NasClient } from "./native";

export const NAS_PREFIX = "nas:";

const OFFLINE = "디자인나스에 연결할 수 없습니다. 서버 PC의 Drive 앱이 켜져 있는지 확인하세요";
const READ_ONLY = "디자인나스는 내려받기만 할 수 있습니다";

export const nasUrl = (peerId: string, path: string) => `nas://${encodeURIComponent(peerId)}${path}`;

export function parseNasUrl(url: string): { peerId: string; path: string } | null {
  const m = /^nas:\/\/([^/]+)(\/.*)?$/.exec(url);
  if (!m) return null;
  try {
    return { peerId: decodeURIComponent(m[1]), path: m[2] ?? "/" };
  } catch {
    return null;
  }
}

const isNas = (libId: string) => libId.startsWith(NAS_PREFIX);
const peerOf = (libId: string) => libId.slice(NAS_PREFIX.length);
const reject = () => Promise.reject(new StorageError("server", READ_ONLY));

async function reach<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch {
    throw new StorageError("network", OFFLINE);
  }
}

/** NAS 하나를 읽기 전용 저장소 하나로 보이게 한다. 내려받기·탐색·검색만 */
export function withNas(inner: StorageProvider, client: NasClient): StorageProvider {
  // token 등은 inner 그대로 두고 메서드만 덮는다
  const nasOnly = <A extends unknown[], R>(fn: (libId: string, ...a: A) => Promise<R>, nas: (libId: string, ...a: A) => Promise<R>) =>
    (libId: string, ...a: A) => (isNas(libId) ? nas(libId, ...a) : fn(libId, ...a));
  const bind = (k: keyof StorageProvider) => (...a: unknown[]) => (inner[k] as (...a: unknown[]) => never).apply(inner, a);

  return new Proxy(inner, {
    get(target, prop) {
      switch (prop) {
        case "listLibraries":
          return async (): Promise<Library[]> => {
            const libs = await inner.listLibraries();
            const rows = await Promise.allSettled(client.peers().map(async (p) => ({ p, info: await client.info(p.id) })));
            const nas: Library[] = [];
            for (const r of rows) {
              if (r.status !== "fulfilled") continue;
              const { p, info } = r.value;
              nas.push({
                id: NAS_PREFIX + p.id,
                name: info.name,
                size: 0,
                mtime: info.version / 1000,
                encrypted: false,
                section: "NAS",
                readOnly: true,
                nas: true,
                headCommitId: String(info.version),
              });
            }
            return [...libs, ...nas];
          };
        case "listDir":
          return nasOnly(bind("listDir"), (id, path: string) => reach(client.list(peerOf(id), path)));
        case "listTree":
          return nasOnly(bind("listTree"), (id) => reach(client.index(peerOf(id))));
        case "downloadUrl":
          return nasOnly(bind("downloadUrl"), (id, path: string) => Promise.resolve(nasUrl(peerOf(id), path)));
        case "listTrash":
          return nasOnly(bind("listTrash"), () => Promise.resolve([]));
        case "upload":
        case "mkdir":
        case "rename":
        case "remove":
        case "move":
        case "createShareLink":
        case "emptyTrash":
        case "restoreTrash":
        case "previewUrl":
        case "readText":
        case "thumbnail":
          return nasOnly(bind(prop), reject);
        default: {
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        }
      }
    },
  });
}
