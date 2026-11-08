//! 서버 TLS 프로브. WebView 의 fetch 는 인증서 오류와 연결 실패를 구분하지 못하므로(둘 다 "Failed to fetch"),
//! 로그인이 네트워크 오류로 끝나면 Rust 로 핸드셰이크를 한 번 해 보고 OS 신뢰 저장소 기준으로 가른다.
//! Waple Drive 의 자체 서명 CA 를 설치하지 않은 PC 는 "certificate" 를 받고, 앱이 /ca.crt 설치를 안내한다.
//! 웹뷰가 부르려면 build.rs COMMANDS 와 capabilities/default.json(allow-tls-probe)에도 있어야 한다.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};

const TIMEOUT: Duration = Duration::from_secs(3);

fn os_roots() -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    for cert in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(cert);
    }
    Arc::new(ClientConfig::builder().with_root_certificates(roots).with_no_client_auth())
}

/// "ok" | "certificate" | "unreachable". 블로킹 I/O(DNS·connect·핸드셰이크)라 async 명령으로 스레드 풀에서 돈다 — 동기면 UI 스레드가 최대 9초 멈춘다
#[tauri::command(async)]
pub fn tls_probe(host: String, port: u16) -> String {
    probe(&host, port, os_roots()).into()
}

fn probe(host: &str, port: u16, cfg: Arc<ClientConfig>) -> &'static str {
    let Ok(addrs) = (host, port).to_socket_addrs() else { return "unreachable" };
    let Some(addr) = addrs.into_iter().next() else { return "unreachable" };
    let Ok(tcp) = TcpStream::connect_timeout(&addr, TIMEOUT) else { return "unreachable" };
    let _ = tcp.set_read_timeout(Some(TIMEOUT));
    let _ = tcp.set_write_timeout(Some(TIMEOUT));
    let Ok(name) = ServerName::try_from(host.to_string()) else { return "unreachable" };
    let Ok(conn) = ClientConnection::new(cfg, name) else { return "unreachable" };
    let mut tls = StreamOwned::new(conn, tcp);
    // rustls 는 첫 I/O 에서 핸드셰이크한다. 한 번 써 보고 한 바이트 읽어 끝까지 진행시킨다
    let req = format!("HEAD /api/v1/ping HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    if let Err(e) = tls.write_all(req.as_bytes()).and_then(|_| tls.flush()) {
        return classify(&e);
    }
    match tls.read(&mut [0u8; 1]) {
        Ok(_eof_or_byte) => "ok", // 0(서버가 닫음)이어도 핸드셰이크는 통과했다
        Err(e) => classify(&e),
    }
}

/// 핸드셰이크 실패는 rustls::Error 를 감싼 io::Error 로 온다. 문자열이 아니라 타입으로 가른다
fn classify(e: &std::io::Error) -> &'static str {
    match e.get_ref().and_then(|inner| inner.downcast_ref::<rustls::Error>()) {
        Some(rustls::Error::InvalidCertificate(_)) => "certificate",
        _ => "unreachable",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    use rustls::{ServerConfig, ServerConnection};
    use std::net::TcpListener;

    /// 127.0.0.1 에 자체 서명 인증서로 TLS 서버를 띄운다(OS 신뢰 저장소에는 없는 CA). 요청을 받으면 한 줄 응답한다
    fn serve() -> (u16, CertificateDer<'static>) {
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec!["127.0.0.1".into()]).unwrap().self_signed(&key).unwrap();
        let der = cert.der().clone();
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der()));
        let cfg = Arc::new(ServerConfig::builder().with_no_client_auth().with_single_cert(vec![der.clone()], key).unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for sock in listener.incoming().flatten() {
                let mut s = StreamOwned::new(ServerConnection::new(cfg.clone()).unwrap(), sock);
                let _ = s.read(&mut [0u8; 512]);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
                let _ = s.flush();
            }
        });
        (port, der)
    }

    #[test]
    fn untrusted_self_signed_ca_is_certificate() {
        let (port, _) = serve();
        assert_eq!(probe("127.0.0.1", port, os_roots()), "certificate");
    }

    #[test]
    fn trusted_ca_is_ok() {
        let (port, der) = serve();
        let mut roots = RootCertStore::empty();
        roots.add(der).unwrap();
        let cfg = Arc::new(ClientConfig::builder().with_root_certificates(roots).with_no_client_auth());
        assert_eq!(probe("127.0.0.1", port, cfg), "ok");
    }

    #[test]
    fn closed_port_is_unreachable() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert_eq!(probe("127.0.0.1", port, os_roots()), "unreachable");
    }

    #[test]
    fn classify_by_error_type() {
        let io = |e: rustls::Error| std::io::Error::new(std::io::ErrorKind::InvalidData, e);
        assert_eq!(classify(&io(rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer))), "certificate");
        assert_eq!(classify(&io(rustls::Error::DecryptError)), "unreachable");
        // 문자열에 certificate 가 들어 있어도 rustls 인증서 오류가 아니면 아니다
        assert_eq!(classify(&std::io::Error::other("certificate request rejected")), "unreachable");
    }

    /// 현장 버그의 원인: tls_probe 가 앱 ACL 에 없어 invoke 가 거부됐고, 프런트는 null → 네트워크 문구로 떨어졌다
    #[test]
    fn every_handler_command_is_allowed_for_main_window() {
        let lib = include_str!("lib.rs");
        let build = include_str!("../build.rs");
        let caps = include_str!("../capabilities/default.json");
        let start = lib.find("generate_handler![").unwrap() + "generate_handler![".len();
        let list = &lib[start..start + lib[start..].find(']').unwrap()];
        for path in list.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let cmd = path.rsplit("::").next().unwrap();
            assert!(build.contains(&format!("\"{cmd}\"")), "build.rs COMMANDS 에 {cmd} 없음");
            if cmd == "greet" {
                continue; // 템플릿 명령, 웹뷰에서 부르지 않는다
            }
            assert!(caps.contains(&format!("\"allow-{}\"", cmd.replace('_', "-"))), "capabilities/default.json 에 allow-{cmd} 없음");
        }
    }
}
