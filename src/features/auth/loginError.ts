import { isMac } from "@/features/shell/platform";
import { InsecureServerError } from "@/storage/session";
import { StorageError } from "@/storage/StorageProvider";

export interface LoginErrorInfo {
  message: string;
  otpRequired: boolean;
}

/** 로그인 실패를 사용자 문구로. 서버가 자격증명 오류에 401 대신 400(credentials 문구)을 주는 경우도 처리한다. */
export function loginErrorMessage(e: unknown, mac = isMac()): LoginErrorInfo {
  if (e instanceof InsecureServerError) return { message: e.message, otpRequired: false };
  if (!(e instanceof StorageError)) return { message: "알 수 없는 오류가 발생했습니다", otpRequired: false };
  const body = e.message.toLowerCase();
  if (body === "otp required" || /two.?factor|otp/.test(body)) return { message: "2단계 인증 코드를 입력하세요", otpRequired: true };
  if (e.kind === "unauthorized" || (e.status === 400 && body.includes("credentials"))) {
    return { message: "아이디 또는 비밀번호가 틀렸습니다", otpRequired: false };
  }
  if (e.kind === "certificate") {
    // 현장에서 흔한 실수: Windows 는 중간 인증 기관에, macOS 는 신뢰 설정 없이 키체인에만 넣는다
    const where = mac ? "키체인에 추가한 뒤 '항상 신뢰'로 설정하세요" : "'신뢰할 수 있는 루트 인증 기관'에 설치하세요";
    return { message: `서버 인증서를 신뢰할 수 없습니다. 관리자에게 받은 CA 인증서를 ${where} (${e.message})`, otpRequired: false };
  }
  if (e.kind === "network") {
    const hint = mac ? " macOS 에서는 시스템 설정 → 개인정보 보호 및 보안 → 로컬 네트워크에서 Drive 를 허용해야 합니다." : "";
    return { message: `서버에 연결할 수 없습니다. 서버 주소와 네트워크를 확인하세요.${hint}`, otpRequired: false };
  }
  return { message: `서버 오류 (${e.status ?? ""})`, otpRequired: false };
}
