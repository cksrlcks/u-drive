//! 서버 TLS 프로브. WebView 의 fetch 는 인증서 오류와 연결 실패를 구분하지 못하므로(둘 다 "Failed to fetch"),
//! 로그인이 네트워크 오류로 끝나면 Rust 로 핸드셰이크를 한 번 해 보고 OS 신뢰 저장소 기준으로 가른다.
//! Waple Drive 의 자체 서명 CA 를 설치하지 않은 PC 는 "certificate" 를 받고, 앱이 /ca.crt 설치를 안내한다.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};

const TIMEOUT: Duration = Duration::from_secs(3);

fn client_config() -> Result<Arc<ClientConfig>, String> {
    let mut roots = RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
        let _ = roots.add(cert);
    }
    let cfg = ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
    Ok(Arc::new(cfg))
}

/// "ok" | "certificate" | "unreachable"
#[tauri::command]
pub fn tls_probe(host: String, port: u16) -> String {
    let Ok(addrs) = (host.as_str(), port).to_socket_addrs() else { return "unreachable".into() };
    let Some(addr) = addrs.into_iter().next() else { return "unreachable".into() };
    let Ok(tcp) = TcpStream::connect_timeout(&addr, TIMEOUT) else { return "unreachable".into() };
    let _ = tcp.set_read_timeout(Some(TIMEOUT));
    let _ = tcp.set_write_timeout(Some(TIMEOUT));
    let Ok(cfg) = client_config() else { return "unreachable".into() };
    let Ok(name) = ServerName::try_from(host.clone()) else { return "unreachable".into() };
    let Ok(conn) = ClientConnection::new(cfg, name) else { return "unreachable".into() };
    let mut tls = StreamOwned::new(conn, tcp);
    // 핸드셰이크를 끝까지 진행시키려면 한 번 써 본다
    let probe = format!("HEAD /api/v1/ping HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    if let Err(e) = tls.write_all(probe.as_bytes()).and_then(|_| tls.flush()) {
        return classify(&e);
    }
    let mut buf = [0u8; 1];
    match tls.read(&mut buf) {
        Ok(_) => "ok".into(),
        Err(e) => classify(&e),
    }
}

fn classify(e: &std::io::Error) -> String {
    let text = e.to_string();
    // rustls 의 InvalidCertificate(UnknownIssuer | NotValidForName | Expired …) 가 io::Error 로 감싸져 온다
    if text.contains("InvalidCertificate") || text.contains("certificate") {
        "certificate".into()
    } else {
        "unreachable".into()
    }
}
