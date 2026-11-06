import { StorageError } from "./StorageProvider";

const aborted = () => new DOMException("aborted", "AbortError");

/** 업로드 진행률이 필요한 요청. fetch는 업로드 진행률을 주지 않아 XHR 사용. 2xx 면 응답 본문 텍스트. */
export function xhrRequest(
  method: string,
  url: string,
  body: Blob | FormData,
  headers: Record<string, string>,
  onProgress: (sent: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const done = () => signal?.removeEventListener("abort", onAbort);
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
      else reject(new StorageError(xhr.status === 401 ? "unauthorized" : "server", xhr.responseText || xhr.statusText, xhr.status));
    };
    xhr.onerror = () => {
      done();
      reject(new StorageError("network", "upload failed"));
    };
    xhr.onabort = () => {
      done();
      reject(aborted());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send(body);
  });
}

/** multipart POST with upload progress. */
export function xhrUpload(
  url: string,
  form: FormData,
  headers: Record<string, string>,
  onProgress: (sent: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return xhrRequest("POST", url, form, headers, onProgress, signal);
}
