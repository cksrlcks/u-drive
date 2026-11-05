import { useQuery } from "@tanstack/react-query";
import { IconChevronLeft, IconChevronRight, IconDownload, IconInfoCircle, IconRotateClockwise, IconX, IconZoomIn, IconZoomOut } from "@tabler/icons-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { EntryIcon } from "@/features/browse/FileList";
import { useThumbnail } from "@/features/browse/useThumbnail";
import { formatDate, formatSize } from "@/lib/format";
import { useStoredState } from "@/lib/useStoredState";
import { parentPath } from "@/storage/path";
import { useStorage } from "@/storage/StorageContext";
import type { Entry } from "@/storage/StorageProvider";
import { FIT, fitScale, zoomAt, type Size, type View } from "./imageView";
import { previewKind } from "./previewKind";

const TEXT_LIMIT = 1024 * 1024;
const STEP = 1.25;
// 마크다운 렌더러는 미리보기를 열 때만 받는다
const MarkdownView = lazy(() => import("./MarkdownView"));
const isMarkdown = (name: string) => /\.(md|markdown)$/i.test(name);
const isHtml = (name: string) => /\.html?$/i.test(name);
/** 원문 말고 그려서 보여 줄 수 있는 텍스트 */
const isRendered = (name: string) => isMarkdown(name) || isHtml(name);

interface Props {
  libId: string;
  /** 현재 폴더에서 미리보기 가능한 파일만 */
  entries: Entry[];
  index: number;
  onClose(): void;
  onNavigate(index: number): void;
  onDownload(entry: Entry): void;
}

/**
 * 파일 목록 자리를 덮는 어두운 뷰어(부모가 relative). 이미지는 확대·이동·회전, 아래 필름스트립, 오른쪽 정보 패널.
 * 열리면 키보드 포커스를 가져와 뒤의 파일 목록이 화살표 키를 받지 않게 한다
 */
export function PreviewModal({ libId, entries, index, onClose, onNavigate, onDownload }: Props) {
  const entry = entries[index];
  const open = entry !== undefined;
  const isImage = !!entry && previewKind(entry.name) === "image";

  const [view, setView] = useState<View>(FIT);
  const [img, setImg] = useState<Size | null>(null);
  const [stage, setStage] = useState<Size>({ w: 1, h: 1 });
  const [info, setInfo] = useStoredState("seadrive.viewer.info", false);
  /** 마크다운·HTML을 원문으로 볼지. 기본은 그려서 보기 */
  const [source, setSource] = useStoredState("seadrive.viewer.source", false);
  useEffect(() => {
    setView(FIT);
    setImg(null);
  }, [entry?.path]);

  // 맞춤일 때 가장자리 여백(좌우는 이전·다음 버튼 자리)
  const fit = img ? fitScale(img, { w: stage.w - 128, h: stage.h - 48 }, view.rot) : 1;
  const scale = view.zoom ?? fit;
  const zoomTo = (to: number, p?: { x: number; y: number }) => setView((v) => zoomAt(v, v.zoom ?? fit, to, p));
  const toggleFit = (p?: { x: number; y: number }) => (view.zoom === null ? zoomTo(fit < 1 ? 1 : 2, p) : setView((v) => ({ ...FIT, rot: v.rot })));
  const rotate = () => setView((v) => ({ ...FIT, rot: (v.rot + 90) % 360 }));

  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) root.current?.focus();
  }, [open]);
  if (!entry) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowLeft" && index > 0) onNavigate(index - 1);
    else if (e.key === "ArrowRight" && index < entries.length - 1) onNavigate(index + 1);
    else if (e.key.toLowerCase() === "i") setInfo((v) => !v);
    else if (!isImage) return;
    else if (e.key === "+" || e.key === "=") zoomTo(scale * STEP);
    else if (e.key === "-") zoomTo(scale / STEP);
    else if (e.key === "0") setView((v) => ({ ...FIT, rot: v.rot }));
    else if (e.key === "1") zoomTo(1);
    else if (e.key.toLowerCase() === "r") rotate();
  };

  return (
    <div ref={root} tabIndex={-1} onKeyDown={onKey} role="dialog" aria-label={entry.name} className="dark absolute inset-0 z-10 flex flex-col overflow-hidden bg-background text-foreground outline-none">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
        <h2 className="min-w-0 truncate pl-1 text-sm font-medium">{entry.name}</h2>
        <span className="shrink-0 px-2 text-xs text-muted-foreground tabular-nums">
          {index + 1} / {entries.length}
        </span>
        <span className="flex-1" />
        {isImage && (
          <>
            <Button variant="ghost" size="icon-sm" onClick={() => zoomTo(scale / STEP)} title="축소 (-)">
              <IconZoomOut className="size-4" />
            </Button>
            <Button variant="ghost" size="sm" className="w-14 tabular-nums" onClick={() => toggleFit()} title={view.zoom === null ? "실제 크기 (1)" : "창에 맞춤 (0)"}>
              {Math.round(scale * 100)}%
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => zoomTo(scale * STEP)} title="확대 (+)">
              <IconZoomIn className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={rotate} title="회전 (R)">
              <IconRotateClockwise className="size-4" />
            </Button>
            <span className="mx-1.5 h-4 w-px bg-border" />
          </>
        )}
        {isRendered(entry.name) && (
          <>
            <div className="flex h-7 items-center rounded-md border border-border p-0.5">
              {([false, true] as const).map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  aria-pressed={source === v}
                  onClick={() => setSource(v)}
                  className={cn("h-full rounded-sm px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50", source === v ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  {v ? "원문" : "미리보기"}
                </button>
              ))}
            </div>
            <span className="mx-1.5 h-4 w-px bg-border" />
          </>
        )}
        <Button variant="ghost" size="icon-sm" aria-pressed={info} className={cn(info && "bg-muted")} onClick={() => setInfo((v) => !v)} title="정보 (I)">
          <IconInfoCircle className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => onDownload(entry)} title="다운로드">
          <IconDownload className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} title="닫기 (Esc)">
          <IconX className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <Stage onResize={setStage}>
            {isImage ? (
              <ImageView key={entry.path} libId={libId} entry={entry} view={view} scale={scale} loaded={!!img} onLoad={setImg} onPan={setView} onZoom={zoomTo} onDoubleClick={toggleFit} />
            ) : (
              <Body key={entry.path} libId={libId} entry={entry} source={source} onDownload={onDownload} />
            )}
          </Stage>
          {index > 0 && <NavButton side="left" onClick={() => onNavigate(index - 1)} />}
          {index < entries.length - 1 && <NavButton side="right" onClick={() => onNavigate(index + 1)} />}
          {entries.length > 1 && <Filmstrip libId={libId} entries={entries} index={index} onNavigate={onNavigate} />}
        </div>
        {info && <InfoPanel entry={entry} img={isImage ? img : null} />}
      </div>
    </div>
  );
}

function Stage({ onResize, children }: { onResize(s: Size): void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => onResize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onResize]);
  return (
    <div ref={ref} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
      {children}
    </div>
  );
}

interface ImageViewProps {
  libId: string;
  entry: Entry;
  view: View;
  scale: number;
  loaded: boolean;
  onLoad(s: Size): void;
  onPan(f: (v: View) => View): void;
  onZoom(to: number, p: { x: number; y: number }): void;
  onDoubleClick(p: { x: number; y: number }): void;
}

function ImageView({ libId, entry, view, scale, loaded, onLoad, onPan, onZoom, onDoubleClick }: ImageViewProps) {
  const storage = useStorage();
  const url = useQuery({ queryKey: ["previewUrl", libId, entry.path], queryFn: () => storage.previewUrl(libId, entry.path) });
  const dragFrom = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // 무대 중심 기준 커서 위치
  const at = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };

  if (url.error) return <Fallback message="불러오지 못했습니다" />;
  return (
    <div
      className={cn("absolute inset-0 select-none", dragging ? "cursor-grabbing" : "cursor-grab")}
      onWheel={(e) => onZoom(scale * Math.exp(-e.deltaY * 0.0015), at(e))}
      onDoubleClick={(e) => onDoubleClick(at(e))}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        dragFrom.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = dragFrom.current;
        if (d) onPan((v) => ({ ...v, zoom: v.zoom ?? scale, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }));
      }}
      onPointerUp={() => {
        dragFrom.current = null;
        setDragging(false);
      }}
    >
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loading />
        </div>
      )}
      {url.data && (
        <img
          src={url.data}
          alt={entry.name}
          draggable={false}
          onLoad={(e) => onLoad({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          // 투명 부분은 체커보드로 깔아야 어두운 뷰어 배경에서 검은 그림이 묻히지 않는다
          className={cn("absolute top-1/2 left-1/2 max-w-none bg-checker shadow-float", !loaded && "invisible")}
          style={{ transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${scale}) rotate(${view.rot}deg)` }}
        />
      )}
    </div>
  );
}

function NavButton({ side, onClick }: { side: "left" | "right"; onClick(): void }) {
  const Icon = side === "left" ? IconChevronLeft : IconChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      title={side === "left" ? "이전 (←)" : "다음 (→)"}
      className={cn(
        "absolute top-[calc(50%-40px)] flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-card/70 text-foreground shadow-float backdrop-blur-sm transition-colors outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring/50",
        side === "left" ? "left-4" : "right-4",
      )}
    >
      <Icon className="size-5" />
    </button>
  );
}

// 지금 파일 앞뒤로 이만큼만 그린다. 2만 장 폴더에서 칸마다 썸네일 훅이 붙어 열기·넘기기가 느려졌다
const STRIP_AROUND = 50;

function Filmstrip({ libId, entries, index, onNavigate }: { libId: string; entries: Entry[]; index: number; onNavigate(i: number): void }) {
  const from = Math.max(0, index - STRIP_AROUND);
  return (
    <div className="h-20 shrink-0 overflow-x-auto border-t border-border px-3">
      <div className="mx-auto flex h-full w-max items-center gap-1.5">
        {entries.slice(from, index + STRIP_AROUND + 1).map((e, k) => (
          <Thumb key={e.path} libId={libId} entry={e} active={from + k === index} onClick={() => onNavigate(from + k)} />
        ))}
      </div>
    </div>
  );
}

function Thumb({ libId, entry, active, onClick }: { libId: string; entry: Entry; active: boolean; onClick(): void }) {
  const [ref, thumb] = useThumbnail(libId, entry, 128);
  const btn = useRef<HTMLButtonElement | null>(null);
  const setRefs = useCallback(
    (el: HTMLButtonElement | null) => {
      btn.current = el;
      ref(el);
    },
    [ref],
  );
  useEffect(() => {
    if (active) btn.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [active]);
  return (
    <button
      ref={setRefs}
      type="button"
      onClick={onClick}
      title={entry.name}
      className={cn(
        "flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active ? "ring-2 ring-primary" : "opacity-55 hover:opacity-100",
      )}
    >
      {thumb ? <img src={thumb} alt="" draggable={false} className="size-full bg-checker object-cover" /> : <EntryIcon entry={entry} size={48} className="size-8" />}
    </button>
  );
}

function InfoPanel({ entry, img }: { entry: Entry; img: Size | null }) {
  const ext = entry.name.includes(".") ? entry.name.split(".").pop()!.toUpperCase() : "";
  const rows: [string, string][] = [
    ["종류", ext ? `${ext} 파일` : "파일"],
    ...(img ? [["해상도", `${img.w} × ${img.h}`] as [string, string]] : []),
    ["크기", formatSize(entry.size)],
    ["수정한 날짜", formatDate(entry.mtime)],
    ["위치", parentPath(entry.path)],
  ];
  return (
    <aside className="flex w-70 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-sidebar p-4 text-sm">
      <div className="font-medium break-all">{entry.name}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

function Body({ libId, entry, source, onDownload }: { libId: string; entry: Entry; source: boolean; onDownload(entry: Entry): void }) {
  const storage = useStorage();
  const kind = previewKind(entry.name);
  const tooBig = kind === "text" && entry.size > TEXT_LIMIT;
  const url = useQuery({
    queryKey: ["previewUrl", libId, entry.path],
    queryFn: () => storage.previewUrl(libId, entry.path),
    enabled: kind === "pdf",
  });
  // PDF: 다운로드 링크는 attachment 헤더가 붙어 iframe이 저장을 시작하므로 blob으로 받아 띄운다
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState(false);
  useEffect(() => {
    if (kind !== "pdf" || !url.data) return;
    let objectUrl: string | null = null;
    const ctrl = new AbortController();
    fetch(url.data, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.statusText))))
      .then((b) => {
        objectUrl = URL.createObjectURL(b.type === "application/pdf" ? b : new Blob([b], { type: "application/pdf" }));
        setPdfUrl(objectUrl);
      })
      .catch((e) => e.name !== "AbortError" && setPdfError(true));
    return () => {
      ctrl.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [kind, url.data]);
  const text = useQuery({
    queryKey: ["text", libId, entry.path],
    queryFn: () => storage.readText(libId, entry.path),
    enabled: kind === "text" && !tooBig,
  });

  if (tooBig)
    return (
      <Fallback message="1MB 이상 텍스트는 미리보기하지 않습니다">
        <Button onClick={() => onDownload(entry)}>
          <IconDownload className="size-4" /> 다운로드
        </Button>
      </Fallback>
    );
  if (url.error || text.error || pdfError) return <Fallback message="불러오지 못했습니다" />;
  if (kind === "pdf") return pdfUrl ? <iframe src={pdfUrl} title={entry.name} className="h-full w-full bg-card" /> : <Loading />;
  if (kind === "text")
    return text.data === undefined ? (
      <Loading />
    ) : isMarkdown(entry.name) && !source ? (
      <Suspense fallback={<Loading />}>
        <MarkdownView text={text.data} />
      </Suspense>
    ) : isHtml(entry.name) && !source ? (
      <HtmlView html={text.data} title={entry.name} />
    ) : (
      <pre className="h-full w-full overflow-auto bg-card p-6 font-mono text-sm leading-relaxed whitespace-pre-wrap">{text.data}</pre>
    );
  return (
    <Fallback message="미리보기를 지원하지 않는 형식입니다">
      <Button onClick={() => onDownload(entry)}>
        <IconDownload className="size-4" /> 다운로드
      </Button>
    </Fallback>
  );
}

/**
 * HTML은 모양만 그린다. sandbox=""라 스크립트·폼 전송·팝업·상위 창 이동이 모두 막히고 출처도 앱과 분리된다
 * (서버에서 받은 파일의 스크립트가 앱 웹뷰에서 돌면 안 된다). 링크는 <base target="_blank">로 새 창에 보내
 * (팝업이 막혀 있어 아무 일도 없다) iframe이 다른 사이트로 넘어가 버리지 않게 한다.
 * CSP로 외부 요청(이미지·CSS·글꼴 등)도 막는다 — 추적용 이미지로 열람 사실이 새지 않게. 문서 안에 넣은 스타일·data: 이미지만 쓴다.
 * 문서가 자기 CSP를 따로 넣어도 정책은 겹쳐 적용돼(모두 통과해야 함) 풀리지 않는다
 */
function HtmlView({ html, title }: { html: string; title: string }) {
  const doc = useMemo(() => {
    const d = new DOMParser().parseFromString(html, "text/html"); // 파싱만 하고 스크립트는 돌리지 않는다
    const base = d.createElement("base");
    base.target = "_blank";
    const csp = d.createElement("meta");
    csp.httpEquiv = "Content-Security-Policy";
    csp.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'";
    d.head.prepend(csp, base);
    return (d.doctype ? "<!doctype html>" : "") + d.documentElement.outerHTML;
  }, [html]);
  // 바탕색이 없는 문서가 많아 흰 바탕을 깐다(뷰어는 어두운 테마)
  return <iframe sandbox="" srcDoc={doc} title={title} className="h-full w-full bg-white" />;
}

function Loading() {
  return <div className="text-sm text-muted-foreground">불러오는 중...</div>;
}

function Fallback({ message, children }: { message: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 text-sm text-muted-foreground">
      <span>{message}</span>
      {children}
    </div>
  );
}
