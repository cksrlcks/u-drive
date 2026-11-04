import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useThumbnailPref } from "@/features/settings/useThumbnailPref";
import { useStorage } from "@/storage/StorageContext";
import { NAS_PREFIX } from "@/storage/nas/withNas";
import type { Entry } from "@/storage/StorageProvider";

// svg는 서버가 썸네일을 만들지 않는다
const THUMB_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

/**
 * 이미지 썸네일 blob URL(아이콘 보기·세부정보 패널). 칸이 화면 가까이 왔을 때만 요청하고(ref를 칸에 붙인다),
 * 받는 중·실패·설정 꺼짐·이미지 아님이면 null → 셸 아이콘을 그대로 쓴다.
 * size는 서버에 요청할 px. 몇 가지 값으로만 써야 서버 썸네일 캐시가 맞는다.
 */
export function useThumbnail(libId: string | null, entry: Entry, size: number): [(el: HTMLElement | null) => void, string | null] {
  const storage = useStorage();
  const [enabled] = useThumbnailPref();
  const ext = entry.name.includes(".") ? entry.name.split(".").pop()!.toLowerCase() : "";
  const wanted = enabled && libId !== null && !libId.startsWith(NAS_PREFIX) && entry.type === "file" && THUMB_EXTS.has(ext);

  const [el, setEl] = useState<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!wanted || seen || !el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [wanted, seen, el]);

  // mtime을 키에 넣어 파일이 바뀌면 새로 받는다
  const q = useQuery({
    queryKey: ["thumbnail", libId, entry.path, entry.mtime, size],
    enabled: wanted && seen,
    staleTime: Infinity,
    retry: false,
    queryFn: ({ signal }) => storage.thumbnail(libId!, entry.path, size, signal),
  });

  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) return setUrl(null);
    const u = URL.createObjectURL(q.data);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [q.data]);

  return [setEl, wanted ? url : null];
}
