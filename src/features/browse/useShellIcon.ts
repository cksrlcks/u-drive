import { useQuery, type QueryClient } from "@tanstack/react-query";
import { isLinux, isTauri } from "@/features/shell/platform";
import type { Entry } from "@/storage/StorageProvider";

// Linux는 셸 아이콘이 없다(file_icon이 항상 실패) → 기존 SVG 아이콘
const supported = isTauri() && !isLinux();

// 화면 배율과 상관없이 고정 크기로 받아 CSS로 줄인다. 배율이 키에 들어가면 확대·축소·모니터 이동 때마다 새로 받느라 SVG가 깜빡였다.
// 목록(16)은 2배 화면까지 선명하게 32, 그리드는 셸 이미지 리스트 상한인 48
const PX = { 16: 32, 48: 48 } as const;

function shellIconQuery(dir: boolean, ext: string, size: 16 | 48) {
  const px = PX[size];
  return {
    queryKey: ["shell-icon", dir, ext, px],
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1, // 폴더를 처음 열 때 확장자별로 몰려 들어가는 호출이 가끔 실패해도 한 번은 다시
    queryFn: async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        const buf = await invoke<ArrayBuffer>("file_icon", { ext, dir, size: px });
        return URL.createObjectURL(new Blob([buf], { type: "image/png" }));
      } catch (e) {
        // 쿼리 캐시 onError가 로그에 남긴다. 어떤 아이콘인지 알 수 있게 붙여서
        throw new Error(`셸 아이콘 ${dir ? "폴더" : `.${ext}`} ${px}px: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/** 가장 많이 보이는 폴더 아이콘을 미리 받아 첫 화면부터 셸 아이콘으로 */
export function prefetchShellIcons(qc: QueryClient) {
  if (!supported) return;
  for (const size of [16, 48] as const) void qc.prefetchQuery(shellIconQuery(true, "", size));
}

/**
 * OS 셸 아이콘(윈도우 탐색기·맥 Finder와 같은 파일/폴더 그림)을 blob URL로. 확장자·크기별로 한 번만 받아 세션 동안 캐시.
 * pending이면 받는 중 → 자리만 잡는다. src도 pending도 아니면(브라우저·실패) 기존 SVG 아이콘을 쓴다.
 */
export function useShellIcon(entry: Entry, size: 16 | 48): { src: string | null; pending: boolean } {
  const dir = entry.type === "dir";
  const ext = !dir && entry.name.includes(".") ? entry.name.split(".").pop()!.toLowerCase() : "";
  const q = useQuery({ ...shellIconQuery(dir, ext, size), enabled: supported });
  return { src: q.data ?? null, pending: supported && q.isPending };
}
