pub mod mcp;
mod localfs;
mod nas;
mod nasfs;
mod nearby;
mod syncfs;
mod tls;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use std::path::PathBuf;
use std::sync::Mutex;

/// 화면 설정 중 Rust 쪽에서 쓰는 것. 프론트가 시작할 때와 바뀔 때 set_prefs로 넘긴다
struct Prefs {
    close_to_tray: bool,
    download_dir: Option<PathBuf>,
}

#[tauri::command]
fn set_prefs(state: State<Mutex<Prefs>>, close_to_tray: bool, download_dir: Option<String>) {
    *state.lock().unwrap() = Prefs { close_to_tray, download_dir: download_dir.map(PathBuf::from) };
}

/// dir 안에서 name과 겹치지 않는 경로. 있으면 "이름 (1).확장자" 식으로 번호를 붙인다. dir이 없으면 만든다(Claude 전용 'U-Drive 작업' 폴더)
#[tauri::command]
fn free_path(dir: String, name: String) -> String {
    let dir = PathBuf::from(dir);
    let _ = std::fs::create_dir_all(&dir);
    let name = localfs::plain_name(&name);
    let p = std::path::Path::new(&name);
    let (stem, ext) = (p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(), p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default());
    let mut path = dir.join(&name);
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    path.to_string_lossy().into_owned()
}

/// 앱 로그 폴더(윈도우 %LOCALAPPDATA%\<id>\logs, 맥 ~/Library/Logs/<id>)의 drive.log
fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("drive.log"))
}

/// 로그 한 줄 추가. 1MB를 넘으면 drive.old.log로 넘기고 새로 쓴다(최대 2MB 남음)
#[tauri::command]
fn append_log(app: AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let path = log_path(&app)?;
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 1_000_000) {
        let _ = std::fs::rename(&path, path.with_file_name("drive.old.log"));
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

/// 받은 파일을 둘 폴더: 설정의 다운로드 폴더, 없으면 시스템 다운로드 폴더
fn download_dir(app: &AppHandle) -> Option<PathBuf> {
    let custom = app.state::<Mutex<Prefs>>().lock().unwrap().download_dir.clone();
    custom.or_else(|| app.path().download_dir().ok())
}

#[tauri::command]
fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let path = log_path(&app)?;
    app.opener().open_path(path.parent().unwrap().to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// OS 셸이 쓰는 파일/폴더 아이콘을 PNG(RGBA)로. 윈도우 탐색기·맥 Finder와 같은 그림. ext는 확장자(없으면 ""), dir이면 폴더.
/// size: 16·32·48 중 하나로 올림. async라 메인 스레드를 막지 않는다.
#[tauri::command]
async fn file_icon(ext: String, dir: bool, size: u32) -> Result<tauri::ipc::Response, String> {
    shell_icon::png(&ext, dir, size).map(tauri::ipc::Response::new)
}

/// 맥: Finder가 쓰는 파일/폴더 아이콘을 size×size PNG로 그린다
#[cfg(target_os = "macos")]
mod shell_icon {
    use objc2::rc::autoreleasepool;
    use objc2::{AnyThread, Message};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};
    use objc2_uniform_type_identifiers::{UTType, UTTypeData, UTTypeFolder};

    pub fn png(ext: &str, dir: bool, size: u32) -> Result<Vec<u8>, String> {
        autoreleasepool(|_| unsafe {
            // 확장자로 UTType을 찾고, 모르는 확장자·확장자 없음은 일반 문서 아이콘
            let ty = if dir {
                UTTypeFolder.retain()
            } else {
                UTType::typeWithFilenameExtension(&NSString::from_str(ext)).unwrap_or_else(|| UTTypeData.retain())
            };
            let icon = NSWorkspace::sharedWorkspace().iconForContentType(&ty);

            let px = size as isize;
            let rep = NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(),
                std::ptr::null_mut(),
                px,
                px,
                8,
                4,
                true,
                false,
                NSDeviceRGBColorSpace,
                0,
                0,
            )
            .ok_or("NSBitmapImageRep")?;
            let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep).ok_or("NSGraphicsContext")?;
            // 다른 스레드의 그리기와 섞이지 않게 이 스레드의 현재 컨텍스트만 잠깐 바꾼다
            NSGraphicsContext::saveGraphicsState_class();
            NSGraphicsContext::setCurrentContext(Some(&ctx));
            // NSImage가 크기에 맞는 해상도 버전을 골라 그린다
            icon.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(size as f64, size as f64)));
            NSGraphicsContext::restoreGraphicsState_class();

            let data = rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()).ok_or("PNG")?;
            Ok(data.to_vec())
        })
    }

    #[cfg(test)]
    mod tests {
        /// 폴더·알려진 확장자·모르는 확장자·확장자 없음 모두 요청한 크기의 PNG가 나와야 한다.
        /// SHELL_ICON_DUMP=<폴더>를 주면 결과 PNG를 저장해 눈으로 확인할 수 있다
        #[test]
        fn renders_png_at_requested_size() {
            let dump = std::env::var("SHELL_ICON_DUMP").ok();
            for (ext, dir) in [("", true), ("pdf", false), ("jpg", false), ("zip", false), ("zzzz", false), ("", false)] {
                for size in [16, 32, 48] {
                    let png = super::png(ext, dir, size).unwrap();
                    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
                    let w = u32::from_be_bytes(png[16..20].try_into().unwrap());
                    let h = u32::from_be_bytes(png[20..24].try_into().unwrap());
                    assert_eq!((w, h), (size, size), "{ext:?} dir={dir}");
                    if let Some(d) = &dump {
                        let name = if dir { "folder".into() } else if ext.is_empty() { "noext".into() } else { ext.to_string() };
                        std::fs::write(format!("{d}/{name}-{size}.png"), &png).unwrap();
                    }
                }
            }
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod shell_icon {
    pub fn png(_ext: &str, _dir: bool, _size: u32) -> Result<Vec<u8>, String> {
        Err("unsupported".into())
    }
}

#[cfg(windows)]
mod shell_icon {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{DeleteObject, GetDC, GetDIBits, ReleaseDC, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS};
    use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Controls::{IImageList, ILD_TRANSPARENT};
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_SYSICONINDEX, SHGFI_USEFILEATTRIBUTES, SHIL_EXTRALARGE, SHIL_LARGE, SHIL_SMALL};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    pub fn png(ext: &str, dir: bool, size: u32) -> Result<Vec<u8>, String> {
        // USEFILEATTRIBUTES: 실제 파일 없이 이름의 확장자만 보고 연결된 아이콘을 찾는다
        let name = if dir { "folder".to_string() } else if ext.is_empty() { "file".to_string() } else { format!("file.{ext}") };
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let attrs = if dir { FILE_ATTRIBUTE_DIRECTORY } else { FILE_ATTRIBUTE_NORMAL };
        let shil = if size <= 16 { SHIL_SMALL } else if size <= 32 { SHIL_LARGE } else { SHIL_EXTRALARGE };
        unsafe {
            let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = (|| {
                let mut info = SHFILEINFOW::default();
                let ok = SHGetFileInfoW(PCWSTR(wide.as_ptr()), attrs, Some(&mut info), std::mem::size_of::<SHFILEINFOW>() as u32, SHGFI_SYSICONINDEX | SHGFI_USEFILEATTRIBUTES);
                if ok == 0 {
                    return Err("SHGetFileInfoW".to_string());
                }
                let list: IImageList = SHGetImageList(shil as i32).map_err(|e| e.to_string())?;
                let hicon = list.GetIcon(info.iIcon, ILD_TRANSPARENT.0).map_err(|e| e.to_string())?;
                let out = icon_to_png(hicon);
                let _ = DestroyIcon(hicon);
                out
            })();
            if com {
                CoUninitialize();
            }
            result
        }
    }

    fn icon_to_png(hicon: HICON) -> Result<Vec<u8>, String> {
        let mut ii = ICONINFO::default();
        let (w, h, mut px, rows) = unsafe {
            GetIconInfo(hicon, &mut ii).map_err(|e| e.to_string())?;
            let hdc = GetDC(None);
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            GetDIBits(hdc, ii.hbmColor, 0, 0, None, &mut bmi, DIB_RGB_COLORS); // 크기만 받는다
            let (w, h) = (bmi.bmiHeader.biWidth, bmi.bmiHeader.biHeight.abs());
            bmi.bmiHeader.biHeight = -h; // top-down
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB.0;
            bmi.bmiHeader.biSizeImage = 0;
            let mut px = vec![0u8; (w.max(0) * h.max(0) * 4) as usize];
            let rows = GetDIBits(hdc, ii.hbmColor, 0, h as u32, Some(px.as_mut_ptr() as *mut _), &mut bmi, DIB_RGB_COLORS);
            ReleaseDC(None, hdc);
            let _ = DeleteObject(ii.hbmColor.into());
            let _ = DeleteObject(ii.hbmMask.into());
            (w, h, px, rows)
        };
        if rows == 0 || w <= 0 || h <= 0 {
            return Err("GetDIBits".to_string());
        }
        // BGRA → RGBA. shortcut: 알파 채널이 없는 구형 아이콘(전부 0)은 불투명 처리, 문제 되면 hbmMask로 투명 적용
        let opaque = px.chunks(4).all(|p| p[3] == 0);
        for p in px.chunks_mut(4) {
            p.swap(0, 2);
            if opaque {
                p[3] = 255;
            }
        }
        let mut out = Vec::new();
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().and_then(|mut wr| wr.write_image_data(&px)).map_err(|e| e.to_string())?;
        Ok(out)
    }
}

/// 이 PC 이름(Seafile 기기별 토큰의 기기 이름, 바로 보내기 목록과 같음)
#[tauri::command]
fn device_name() -> String {
    nearby::device_name()
}

/// 창 닫기가 트레이로 숨기기일 때 실제 종료는 이 커맨드로
#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 이미 떠 있으면 새로 띄우지 않고 기존 창을 앞으로. MCP 중계가 띄운 자동 실행(--autostart)이면 창은 그대로 숨김
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|a| a == "--autostart") {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_upload::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .manage(Mutex::new(Prefs { close_to_tray: true, download_dir: None }))
        .manage(syncfs::Watchers::default())
        .setup(|app| {
            mcp::setup(app.handle());
            nearby::setup(app.handle());
            nas::setup(app.handle());
            // 로그인할 때 자동 실행이면 창 없이 트레이에만 둔다
            if std::env::args().any(|a| a == "--autostart") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
            let sep = || PredefinedMenuItem::separator(app);
            let version = MenuItem::new(app, format!("U-Drive v{}", app.package_info().version), false, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &item("open", "U-Drive 열기")?,
                    &sep()?,
                    &item("upload", "파일 업로드…")?,
                    &item("nearby", "바로 보내기…")?,
                    &item("refresh", "새로고침")?,
                    &item("downloads", "다운로드 폴더 열기")?,
                    &sep()?,
                    &item("settings", "설정…")?,
                    &item("logout", "로그아웃")?,
                    &sep()?,
                    &version,
                    &item("quit", "종료")?,
                ],
            )?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                // macOS 메뉴 막대는 흑백 템플릿 아이콘이 관례. 알파(구름 모양)만 써서 다크/라이트에 맞춰 그려진다
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("U-Drive")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    "downloads" => {
                        if let Some(dir) = download_dir(app) {
                            let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
                        }
                    }
                    // 나머지는 화면 쪽 동작: 창을 띄우고 프론트로 넘긴다
                    id => {
                        show_main(app);
                        let _ = app.emit("tray", id);
                    }
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // 화면이 새로 로드되면(새로고침·오류 복구) Claude 요청 중 답을 못 받게 된 것을 끝내고 다시 준비를 기다린다
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                if let Some(hub) = webview.try_state::<std::sync::Arc<mcp::Hub>>() {
                    hub.reset();
                }
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<Mutex<Prefs>>().lock().unwrap().close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![greet, file_icon, quit, device_name, set_prefs, free_path, append_log, open_log_dir, mcp::mcp_ready, mcp::mcp_respond, localfs::read_local_file, localfs::recent_files, localfs::real_path, localfs::write_local_file, localfs::list_upload_files, localfs::read_local_range, nearby::nearby_start, nearby::nearby_stop, nearby::nearby_peers, nearby::nearby_offers, nearby::nearby_send, nearby::nearby_answer, nearby::nearby_cancel, nearby::nearby_cleanup, nearby::nearby_open_settings, syncfs::sync_scan, syncfs::sync_watch, syncfs::sync_unwatch, syncfs::sync_state_read, syncfs::sync_state_write, syncfs::sync_state_delete, nas::nas_host_start, nas::nas_host_stop, nas::nas_host_status, nas::nas_verify_reply])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            if let tauri::RunEvent::Exit = _event {
                nearby::shutdown(_app);
                nas::shutdown(_app);
            }
            // macOS: 창을 숨긴 뒤 Dock 아이콘을 누르면 다시 띄운다
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = _event {
                show_main(_app);
            }
        });
}
