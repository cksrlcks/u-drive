import { useCallback, useState } from "react";

export type ColKey = "mtime" | "size";

function load<K extends string>(key: string, defaults: Record<K, number>): Record<K, number> {
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<Record<K, number>>) };
  } catch {
    return defaults;
  }
}

/**
 * 표 열 너비. 첫 열은 남는 공간, 나머지는 px. 머리글 오른쪽 경계를 끌면 "다음 열"의 너비가 바뀐다(탐색기 방식).
 * storageKey별로 localStorage에 기억. 표마다 각자 키를 쓴다.
 */
export function useColumnWidths<K extends string>(storageKey: string, defaults: Record<K, number>, mins: Record<K, number>) {
  const [widths, setWidths] = useState<Record<K, number>>(() => load(storageKey, defaults));

  const startResize = useCallback(
    (key: K, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = widths[key];
      const onMove = (ev: PointerEvent) => {
        const w = Math.max(mins[key], Math.round(startW - (ev.clientX - startX)));
        setWidths((s) => (s[key] === w ? s : { ...s, [key]: w }));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setWidths((s) => {
          try {
            localStorage.setItem(storageKey, JSON.stringify(s));
          } catch {
            /* ignore */
          }
          return s;
        });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [widths, storageKey, mins],
  );

  return { widths, startResize };
}
