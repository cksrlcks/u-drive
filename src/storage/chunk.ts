export const CHUNK_SIZE = 8 * 1024 * 1024;

export interface Range {
  start: number;
  /** inclusive (Content-Range 형식) */
  end: number;
}

/** 빈 배열 = Content-Range 없이 단일 POST(작은 파일) 또는 보낼 것 없음(이미 완료) */
export function chunkRanges(total: number, offset: number, chunkSize = CHUNK_SIZE): Range[] {
  if (offset >= total) return [];
  if (offset === 0 && total <= chunkSize) return [];
  const ranges: Range[] = [];
  for (let start = offset; start < total; start += chunkSize) {
    ranges.push({ start, end: Math.min(start + chunkSize, total) - 1 });
  }
  return ranges;
}
