import { InsecureServerError } from "@/storage/session";
import { StorageError } from "@/storage/StorageProvider";

export interface LoginErrorInfo {
  message: string;
  otpRequired: boolean;
}

/** 로그인 실패를 사용자 문구로. 서버가 자격증명 오류에 401 대신 400(credentials 문구)을 주는 경우도 처리한다. */
export function loginErrorMessage(e: unknown): LoginErrorInfo {
  if (e instanceof InsecureServerError) return { message: e.message, otpRequired: false };
  if (!(e instanceof StorageError)) return { message: "알 수 없는 오류가 발생했습니다", otpRequired: false };
  const body = e.message.toLowerCase();
  if (body === "otp required" || /two.?factor|otp/.test(body)) return { message: "2단계 인증 코드를 입력하세요", otpRequired: true };
  if (e.kind === "unauthorized" || (e.status === 400 && body.includes("credentials"))) {
    return { message: "아이디 또는 비밀번호가 틀렸습니다", otpRequired: false };
  }
  if (e.kind === "certificate") return { message: `서버 인증서를 신뢰할 수 없습니다. 관리자에게 받은 CA 인증서를 설치하세요 (${e.message})`, otpRequired: false };
  if (e.kind === "network") return { message: "서버에 연결할 수 없습니다. 서버 주소와 CORS 설정을 확인하세요", otpRequired: false };
  return { message: `서버 오류 (${e.status ?? ""})`, otpRequired: false };
}
