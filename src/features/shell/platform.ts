export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isMac = () => /Mac/i.test(navigator.platform) || /Mac OS/i.test(navigator.userAgent);
export const isLinux = () => /Linux/i.test(navigator.platform);
/** Windows에서만 창 버튼을 직접 그린다(decorations: false). macOS는 신호등 버튼, Linux는 OS 제목 표시줄이 남아 있다. */
export const showWindowControls = () => isTauri() && !isMac() && !isLinux();
export const modKey = () => (isMac() ? "⌘" : "Ctrl");

/** 웹뷰 안이 아니라 기본 브라우저로 연다 */
export function openExternal(url: string) {
  if (isTauri()) void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url));
  else window.open(url, "_blank");
}
