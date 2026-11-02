import { IconUpload } from "@tabler/icons-react";
import { type ReactNode, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useDropzone } from "react-dropzone";
import { isLinux, isTauri } from "@/features/shell/platform";
import type { UploadTask } from "@/storage/StorageProvider";
import { localTasks, pickFolder } from "./localUpload";
import { toUploadTasks } from "./planUploads";

export interface DropZoneHandle {
  /** 헤더 [업로드] 버튼용 파일 선택 열기 */
  open(): void;
  /** 폴더 선택 창으로 폴더째 올리기(데스크톱 앱) */
  openFolder(): void;
}

interface Props {
  targetDir: string;
  children: ReactNode;
  onFiles(tasks: UploadTask[]): void;
  handle?: Ref<DropZoneHandle>;
  /** 읽기 전용 저장소: 끌어다 놓기·파일 선택을 끈다 */
  disabled?: boolean;
}

// Linux WebView(WebKitGTK)는 OS에서 끌어다 놓은 파일을 HTML5 drop으로 제대로 못 넘긴다 → Tauri 드롭 이벤트(경로)로 받는다
const nativeDrop = isTauri() && isLinux();

export function DropZone({ targetDir, children, onFiles, handle, disabled }: Props) {
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    noClick: true,
    noKeyboard: true,
    noDrag: nativeDrop,
    disabled,
    useFsAccessApi: false,
    onDrop: (files) => files.length && onFiles(toUploadTasks(files, targetDir)),
  });

  // 경로로 받은 파일·폴더 올리기. 구독을 매 렌더 다시 하지 않게 최신 값은 ref로
  const latest = useRef({ targetDir, onFiles });
  useEffect(() => {
    latest.current = { targetDir, onFiles };
  });
  const uploadPaths = (paths: string[]) => {
    const { targetDir, onFiles } = latest.current;
    void localTasks(paths, targetDir).then((tasks) => tasks.length && onFiles(tasks));
  };

  const [nativeOver, setNativeOver] = useState(false);
  useEffect(() => {
    if (!nativeDrop || disabled) return;
    const off = import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent(({ payload: p }) => {
        setNativeOver(p.type === "enter" || p.type === "over");
        if (p.type === "drop" && p.paths.length) uploadPaths(p.paths);
      }),
    );
    return () => void off.then((f) => f());
  }, [disabled]);

  useImperativeHandle(
    handle,
    () => ({
      open: disabled ? () => {} : open,
      openFolder: () => {
        if (!disabled) void pickFolder().then((dir) => dir && uploadPaths([dir]));
      },
    }),
    [open, disabled],
  );

  return (
    <div {...getRootProps({ className: "relative flex min-h-0 flex-1 flex-col outline-none" })}>
      <input {...getInputProps()} />
      {children}
      {(isDragActive || nativeOver) && (
        <div className="pointer-events-none absolute inset-1 z-10 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-primary/70 bg-primary/5 text-sm">
          <IconUpload className="size-6 text-primary" />
          <span>
            여기에 놓으면 <span className="font-medium">{targetDir}</span> 에 업로드
          </span>
        </div>
      )}
    </div>
  );
}
