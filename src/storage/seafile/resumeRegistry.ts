/**
 * 이어올리기 대상 기록. "이 앱이 청크 업로드를 시작했다가 끝내지 못한 파일"만 서버 temp에서 이어 받는다.
 * 같은 이름의 다른 파일이 옛 temp에 이어 붙는 사고(손상·거짓 완료)를 막는다.
 * 키 = 이름 + 크기 + 수정시각. localStorage가 없으면(테스트) 메모리.
 */
const KEY = "seadrive.interruptedUploads";
const mem = new Set<string>();

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
function load(): Set<string> {
  const s = store();
  if (!s) return mem;
  try {
    return new Set(JSON.parse(s.getItem(KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function save(set: Set<string>) {
  const s = store();
  if (!s) return;
  s.setItem(KEY, JSON.stringify([...set]));
}
type FileKey = { name: string; size: number; lastModified: number };
const keyOf = (f: FileKey) => `${f.name}|${f.size}|${f.lastModified}`;

export function markInterrupted(f: FileKey): void {
  const set = load();
  set.add(keyOf(f));
  save(set);
}
export function clearInterrupted(f: FileKey): void {
  const set = load();
  set.delete(keyOf(f));
  save(set);
}
export function isInterrupted(f: FileKey): boolean {
  return load().has(keyOf(f));
}
