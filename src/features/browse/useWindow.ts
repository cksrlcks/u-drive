import { useLayoutEffect, useState, type RefObject } from "react";

/** 화면 위에서 아래까지 보이는 줄 범위 [start, end). 위아래로 overscan 줄씩 더 */
export function visibleRange(scrollTop: number, height: number, count: number, offset: number, stride: number, overscan: number) {
  const start = Math.max(0, Math.floor((scrollTop - offset) / stride) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + height - offset) / stride) + overscan);
  return { start: Math.min(start, end), end };
}

/**
 * 높이가 같은 줄이 많은 목록에서 화면 근처 줄만 그리기(2만 개 폴더도 수십 줄만 렌더링).
 * offset은 스크롤 영역 맨 위에서 첫 줄까지, stride는 줄 간격(px). 범위가 바뀔 때만 다시 그린다.
 * reveal(i)는 i번째 줄이 보이게 스크롤한다(stickyTop은 고정 머리글 높이).
 */
export function useWindow(scrollRef: RefObject<HTMLElement | null>, count: number, offset: number, stride: number, overscan = 10) {
  const [range, setRange] = useState({ start: 0, end: 0 });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const r = visibleRange(el.scrollTop, el.clientHeight, count, offset, stride, overscan);
      setRange((p) => (p.start === r.start && p.end === r.end ? p : r));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollRef, count, offset, stride, overscan]);

  const reveal = (i: number, stickyTop = 0) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = offset + i * stride;
    if (top < el.scrollTop + stickyTop) el.scrollTop = top - stickyTop;
    else if (top + stride > el.scrollTop + el.clientHeight) el.scrollTop = top + stride - el.clientHeight;
  };
  return { ...range, reveal };
}
