import { useMemo, useSyncExternalStore } from "react";
import type { SyncLink } from "@/features/sync/type";

const KEY = "seadrive.sync.links";
const listeners = new Set<() => void>();

function load(): SyncLink[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as SyncLink[];
  } catch {
    return [];
  }
}

let current = load();

function save(next: SyncLink[]) {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // 저장 못 해도 이번 실행 동안은 유지된다
  }
  listeners.forEach((l) => l());
}

export const accountKey = (baseUrl: string, email: string) => `${baseUrl}|${email}`;

export const getLinks = (account: string) => current.filter((l) => l.account === account);

export function useLinks(account: string): SyncLink[] {
  const all = useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, () => current);
  return useMemo(() => all.filter((l) => l.account === account), [all, account]);
}

export const addLink = (link: SyncLink) => save([...current, link]);
export const updateLink = (id: string, patch: Partial<SyncLink>) => save(current.map((l) => (l.id === id ? { ...l, ...patch } : l)));
export const removeLink = (id: string) => save(current.filter((l) => l.id !== id));

/** parent 자신이거나 그 아래인가('/' 경계 기준) */
const within = (path: string, parent: string) => path === parent || path.startsWith(parent + "/");

/** path가 연결 폴더 자체이거나 그 안이면 그 연결 */
export function findLink(links: SyncLink[], libId: string, path: string): SyncLink | undefined {
  return links.find((l) => l.libId === libId && within(path, l.drivePath));
}

/** 앱 안 이름 변경·이동: oldPath가 연결 폴더이거나 그 조상이면 drivePath 앞부분을 newPath로 바꾼 목록 */
export function followMove(links: SyncLink[], libId: string, oldPath: string, newPath: string): SyncLink[] {
  return links.map((l) => (l.libId === libId && within(l.drivePath, oldPath) ? { ...l, drivePath: newPath + l.drivePath.slice(oldPath.length) } : l));
}
