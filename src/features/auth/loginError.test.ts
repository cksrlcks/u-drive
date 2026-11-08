import { describe, expect, it } from "vitest";
import { StorageError } from "@/storage/StorageProvider";
import { loginErrorMessage } from "./loginError";

describe("loginErrorMessage", () => {
  it("maps Seafile's 400 credentials error to wrong password", () => {
    const e = new StorageError("server", '{"non_field_errors":["Unable to login with provided credentials."]}', 400);
    expect(loginErrorMessage(e)).toEqual({ message: "아이디 또는 비밀번호가 틀렸습니다", otpRequired: false });
  });
  it("maps 401 to wrong password", () => {
    expect(loginErrorMessage(new StorageError("unauthorized", "", 401)).message).toBe("아이디 또는 비밀번호가 틀렸습니다");
  });
  it("detects two-factor requirement from body", () => {
    const e = new StorageError("server", '{"detail":"Two factor auth token is missing."}', 400);
    expect(loginErrorMessage(e)).toEqual({ message: "2단계 인증 코드를 입력하세요", otpRequired: true });
  });
  it("detects two-factor requirement from header marker", () => {
    expect(loginErrorMessage(new StorageError("server", "otp required", 400)).otpRequired).toBe(true);
  });
  it("explains network failures without CORS, with the Local Network hint on macOS", () => {
    const e = new StorageError("network", "Failed to fetch");
    expect(loginErrorMessage(e, false).message).toBe("서버에 연결할 수 없습니다. 서버 주소와 네트워크를 확인하세요.");
    expect(loginErrorMessage(e, true).message).toBe(
      "서버에 연결할 수 없습니다. 서버 주소와 네트워크를 확인하세요. macOS 에서는 시스템 설정 → 개인정보 보호 및 보안 → 로컬 네트워크에서 Drive 를 허용해야 합니다.",
    );
  });
  it("explains certificate failures with the CA address and where to trust it", () => {
    const e = new StorageError("certificate", "https://drive.example:8443/ca.crt");
    expect(loginErrorMessage(e, false).message).toBe("서버 인증서를 신뢰할 수 없습니다. 관리자에게 받은 CA 인증서를 '신뢰할 수 있는 루트 인증 기관'에 설치하세요 (https://drive.example:8443/ca.crt)");
    expect(loginErrorMessage(e, true).message).toBe("서버 인증서를 신뢰할 수 없습니다. 관리자에게 받은 CA 인증서를 키체인에 추가한 뒤 '항상 신뢰'로 설정하세요 (https://drive.example:8443/ca.crt)");
  });
  it("falls back for unknown errors", () => {
    expect(loginErrorMessage(new Error("x")).message).toBe("알 수 없는 오류가 발생했습니다");
  });
});
