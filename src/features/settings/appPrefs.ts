import { useSyncExternalStore } from "react";
import { isTauri } from "@/features/shell/platform";

export type Theme = "system" | "light" | "dark";
export type Font = "system" | "pretendard" | "geist";

export interface AppPrefs {
  theme: Theme;
  font: Font;
  /** 화면 배율(1 = 100%). 글자 크기가 px로 고정돼 있어 웹뷰 배율로 키운다 */
  zoom: number;
  /** 창 닫기 = 트레이로 숨기기. 끄면 앱 종료 */
  closeToTray: boolean;
  /** 다운로드 폴더. null이면 받을 때마다 묻는다 */
  downloadDir: string | null;
  /** 바로 보내기: 같은 네트워크·같은 서버의 U-Drive에 나를 보이고 서로 파일을 주고받는다 */
  nearbyVisible: boolean;
  /** 바로 보내기로 받은 파일을 둘 곳. null이면 처음 받을 때 고른다 */
  receiveTo: "pc" | "drive" | null;
  /** 바로 보내기로 PC에 받을 폴더. null이면 다운로드 위치(없으면 시스템 다운로드 폴더) */
  receivePcDir: string | null;
  /** 드라이브로 받을 폴더. null이면 로그인할 때 내 첫 저장소의 '받은 파일'로 정한다(폴더는 받을 때 만든다) */
  receiveDrive: DriveFolder | null;
  /** NAS로 열어 둔 PC 폴더(읽기 전용). null이면 닫힘 */
  nasRoot: string | null;
  /** NAS를 열 때의 계정 이름(다른 PC에 보이는 이름). 서버 PC가 켜질 때 서버가 아직 안 떠 있어도 이 이름으로 다시 연다 */
  nasName: string | null;
}

export interface DriveFolder {
  libId: string;
  libName: string;
  path: string;
}

const KEY = "seadrive.prefs";
const DEFAULTS: AppPrefs = { theme: "system", font: "system", zoom: 1, closeToTray: true, downloadDir: null, nearbyVisible: true, receiveTo: null, receivePcDir: null, receiveDrive: null, nasRoot: null, nasName: null };
const listeners = new Set<() => void>();

function load(): AppPrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AppPrefs>) };
  } catch {
    return DEFAULTS;
  }
}

let current = load();

export const getPrefs = () => current;

export function setPrefs(patch: Partial<AppPrefs>) {
  // 다른 창이 바꾼 값을 덮어쓰지 않게 저장된 최신값에 덧붙인다
  current = { ...load(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // 저장 못 해도 이번 실행 동안은 유지된다
  }
  apply(current);
  listeners.forEach((l) => l());
}

export function useAppPrefs(): AppPrefs {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, getPrefs);
}

const darkQuery = typeof matchMedia === "undefined" ? null : matchMedia("(prefers-color-scheme: dark)");

/** 화면(테마·글꼴·배율)과 Rust 쪽(창 닫기·트레이의 다운로드 폴더)에 반영 */
function applyLook(p: AppPrefs) {
  const root = document.documentElement;
  root.classList.toggle("dark", p.theme === "dark" || (p.theme === "system" && !!darkQuery?.matches));
  root.dataset.font = p.font;
}

/** 바로 보내기 팝업 창이면 테마·글꼴만 맞춘다(배율·Rust 설정은 메인 창 몫) */
let popup = false;

function apply(p: AppPrefs) {
  applyLook(p);
  if (!isTauri() || popup) return;
  void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().setZoom(p.zoom)).catch(() => {});
  // 맥 신호등·타이틀바 색을 앱 테마에 맞춘다(system이면 OS를 따름)
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTheme(p.theme === "system" ? null : p.theme)).catch(() => {});
  void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_prefs", { closeToTray: p.closeToTray, downloadDir: p.downloadDir })).catch(() => {});
}

/** 바로 보내기 팝업 창에서 한 번(initPrefs 대신) */
export function initPopupPrefs() {
  popup = true;
  initPrefs();
}

/** 앱 시작 시 한 번. 시스템 테마가 바뀌면 따라간다 */
export function initPrefs() {
  apply(current);
  darkQuery?.addEventListener("change", () => current.theme === "system" && apply(current));
  // 다른 창(바로 보내기 팝업 ↔ 메인)에서 바꾼 설정을 바로 따른다
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    current = load();
    apply(current);
    listeners.forEach((l) => l());
  });
}
