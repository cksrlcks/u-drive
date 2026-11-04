import { getPrefs, setPrefs } from "@/features/settings/appPrefs";
import { isPersistent } from "@/storage/session";

/** 앱을 켜 두는 설정(자동 실행·트레이·자동 로그인) 중 꺼진 것이 있나 */
export async function needsKeepOn(): Promise<{ any: boolean; autoLoginOff: boolean }> {
  const autostart = await import("@tauri-apps/plugin-autostart").then((a) => a.isEnabled()).catch(() => true);
  const autoLogin = isPersistent();
  return { any: !autostart || !getPrefs().closeToTray || !autoLogin, autoLoginOff: !autoLogin };
}

/** 모두 켠다. 자동 실행을 못 켰으면 그 문구, 아니면 null */
export async function enableKeepOn(makePersistent: () => void): Promise<string | null> {
  let failed: string | null = null;
  try {
    await import("@tauri-apps/plugin-autostart").then((a) => a.enable());
  } catch (e) {
    failed = `자동 실행을 켜지 못했습니다 (${e instanceof Error ? e.message : String(e)})`;
  }
  setPrefs({ closeToTray: true });
  makePersistent();
  return failed;
}
