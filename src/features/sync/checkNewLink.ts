import { findLink } from "@/features/sync/links";
import type { SyncLink } from "@/features/sync/type";

export type NewLinkCheck = { ok: true; existing: boolean } | { ok: false; reason: string };

/** 겹침 비교용: 구분자 통일·끝 '/' 제거, Windows 경로는 대소문자 무시 */
function norm(p: string) {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(p) || p.startsWith("\\\\") ? s.toLowerCase() : s;
}

const contains = (a: string, b: string) => a === b || b.startsWith(a + "/");

/** 드라이브 루트(C:\)·네트워크 공유 루트(\\server\share)·'/'는 폴더가 아니라 디스크 전체다 */
export const isWholeDrive = (p: string) => /^([a-z]:)?[\\/]?$/i.test(p) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?$/.test(p);

export function checkNewLink(a: {
  links: SyncLink[];
  libId: string;
  dir: string;
  localRoot: string;
  name: string;
  lib: { readOnly?: boolean; encrypted: boolean };
  existing: { type: "file" | "dir" } | undefined; // 지금 폴더에서 name과 같은 항목
  totalBytes: number;
  quotaLeft: number | null; // null = 무제한
}): NewLinkCheck {
  const no = (reason: string): NewLinkCheck => ({ ok: false, reason });
  if (a.lib.readOnly) return no("읽기 전용 저장소에는 동기화 폴더를 만들 수 없습니다");
  if (a.lib.encrypted) return no("암호화된 저장소에는 동기화 폴더를 만들 수 없습니다");
  if (findLink(a.links, a.libId, a.dir)) return no("이미 동기화 중인 폴더 안에는 만들 수 없습니다");
  const mine = norm(a.localRoot);
  if (a.links.some((l) => contains(norm(l.localRoot), mine) || contains(mine, norm(l.localRoot)))) return no("이미 동기화 중인 PC 폴더와 겹칩니다");
  if (a.existing?.type === "file") return no("같은 이름의 파일이 있습니다");
  if (a.quotaLeft !== null && a.totalBytes > a.quotaLeft) return no("드라이브 남은 용량이 부족합니다");
  return { ok: true, existing: a.existing?.type === "dir" };
}
