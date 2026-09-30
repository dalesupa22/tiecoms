// chaggu de escritorio (macOS y Windows): la misma web de apps/web empaquetada en local,
// hablando con https://app.chaggu.com, más lo que un navegador no da: notificaciones del
// sistema, enlaces chaggu://, token de sesión en el Llavero / Administrador de credenciales,
// ventana que se oculta al cerrar, bandeja, descargas a la carpeta Descargas y llamadas con
// micrófono, cámara y pantalla compartida.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{DownloadEvent, NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::webview::Color;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Theme, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const MAIN: &str = "main";
const KEYRING_SERVICE: &str = "com.chaggu.desktop";
const KEYRING_USER: &str = "refresh-token";

/// Ruta interna pendiente de un enlace que llegó antes de que la web estuviera lista.
#[derive(Default)]
struct PendingPath(Mutex<Option<String>>);

/// chaggu://auth/callback?code=… → /auth/sso?code=…; chaggu://c/<id> → /c/<id>.
fn link_to_path(url: &Url) -> Option<String> {
  if url.scheme() != "chaggu" {
    return None;
  }
  let host = url.host_str().unwrap_or("");
  let mut path = format!("/{host}{}", url.path()).trim_end_matches('/').to_string();
  if path == "/auth/callback" {
    path = "/auth/sso".into();
  }
  if path.is_empty() {
    path = "/".into();
  }
  // Solo rutas de la app: nada de '//' (sería otro origen) ni caracteres raros.
  if path.starts_with("//") || !path.chars().all(|c| c.is_ascii_alphanumeric() || "/-_.~%".contains(c)) {
    return None;
  }
  Some(match url.query() {
    Some(q) => format!("{path}?{q}"),
    None => path,
  })
}

fn show_main(app: &AppHandle) {
  if let Some(w) = app.get_webview_window(MAIN) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
  }
}

fn handle_links(app: &AppHandle, urls: Vec<Url>) {
  for url in urls {
    if let Some(path) = link_to_path(&url) {
      *app.state::<PendingPath>().0.lock().unwrap() = Some(path.clone());
      let _ = app.emit("chaggu:navigate", path);
    }
  }
  show_main(app);
}

/// Lo abre la web al arrancar para no perder el enlace con el que se lanzó la app.
#[tauri::command]
fn take_pending_path(state: tauri::State<PendingPath>) -> Option<String> {
  state.0.lock().unwrap().take()
}

fn keyring_entry() -> Result<keyring::Entry, String> {
  keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get() -> Option<String> {
  keyring_entry().ok()?.get_password().ok()
}

#[tauri::command]
fn secret_set(value: Option<String>) -> Result<(), String> {
  let entry = keyring_entry()?;
  match value {
    Some(v) if !v.is_empty() => entry.set_password(&v).map_err(|e| e.to_string()),
    _ => match entry.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
      Err(e) => Err(e.to_string()),
    },
  }
}

// ---------- Tema claro/oscuro (web: src/theme.ts) ----------
// La web guarda la elección en su localStorage, que Rust no lee al arrancar: se copia a un archivo
// («theme» en la carpeta de configuración) para abrir la ventana ya con el tema y el fondo correctos, sin destello blanco.
const THEME_FILE: &str = "theme";

/// Fondo de la ventana (= --paper de la web) según el tema.
fn theme_bg(theme: Theme) -> Color {
  match theme {
    Theme::Dark => Color(0x15, 0x14, 0x13, 0xff),
    _ => Color(0xf4, 0xf1, 0xea, 0xff),
  }
}

/// "light" | "dark" fijan el tema; cualquier otra cosa (o nada) sigue al sistema.
fn parse_theme(pref: &str) -> Option<Theme> {
  match pref.trim() {
    "dark" => Some(Theme::Dark),
    "light" => Some(Theme::Light),
    _ => None,
  }
}

fn saved_theme(app: &AppHandle) -> Option<Theme> {
  let path = app.path().app_config_dir().ok()?.join(THEME_FILE);
  parse_theme(&std::fs::read_to_string(path).ok()?)
}

/// La web avisa cada vez que cambia el tema: barra de título nativa, fondo de la ventana y lo guardado para el próximo arranque.
#[tauri::command]
fn set_theme(app: AppHandle, pref: String, dark: bool) -> Result<(), String> {
  if let Ok(dir) = app.path().app_config_dir() {
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(THEME_FILE), &pref);
  }
  if let Some(w) = app.get_webview_window(MAIN) {
    w.set_theme(parse_theme(&pref)).map_err(|e| e.to_string())?;
    let _ = w.set_background_color(Some(theme_bg(if dark { Theme::Dark } else { Theme::Light })));
  }
  Ok(())
}

/// Origen de la interfaz empaquetada (o del servidor de desarrollo).
fn is_app_url(url: &Url) -> bool {
  match url.scheme() {
    "tauri" | "about" | "blob" | "data" => true,
    "http" | "https" => matches!(url.host_str(), Some("tauri.localhost")) || (cfg!(debug_assertions) && matches!(url.host_str(), Some("localhost"))),
    _ => false,
  }
}

fn open_external(app: &AppHandle, url: &Url) {
  if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
  }
}

/// Descargas → carpeta Descargas, sin pisar un archivo que ya exista.
fn download_target(app: &AppHandle, url: &Url, suggested: &PathBuf) -> PathBuf {
  let dir = app.path().download_dir().unwrap_or_else(|_| std::env::temp_dir());
  let name = suggested
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .filter(|n| !n.is_empty())
    .or_else(|| url.path_segments().and_then(|mut s| s.next_back().map(str::to_string)).filter(|n| !n.is_empty()))
    .unwrap_or_else(|| "archivo".into());
  let name: String = name.chars().map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c }).collect();
  let (stem, ext) = match name.rfind('.') {
    Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
    _ => (name.clone(), String::new()),
  };
  let mut target = dir.join(&name);
  let mut n = 1;
  while target.exists() {
    target = dir.join(format!("{stem} ({n}){ext}"));
    n += 1;
  }
  target
}

fn main() {
  let app = tauri::Builder::default()
    // Primero: en Windows un enlace chaggu:// lanza otro proceso; este le pasa el enlace al que ya corre.
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .manage(PendingPath::default())
    .invoke_handler(tauri::generate_handler![take_pending_path, secret_get, secret_set, set_theme])
    .setup(|app| {
      let handle = app.handle().clone();

      #[cfg(any(windows, target_os = "linux"))]
      {
        // En macOS el esquema lo declara el Info.plist del paquete; aquí se registra al instalar/arrancar.
        let _ = app.deep_link().register_all();
      }
      if let Ok(Some(urls)) = app.deep_link().get_current() {
        handle_links(&handle, urls);
      }
      let h = handle.clone();
      app.deep_link().on_open_url(move |event| handle_links(&h, event.urls()));

      let nav = handle.clone();
      let popup = handle.clone();
      let dl = handle.clone();
      // Tema guardado (o el del sistema): la ventana nace con su fondo, sin destello blanco antes del primer pintado.
      let theme = saved_theme(&handle);
      let win = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("chaggu")
        .theme(theme)
        .background_color(theme_bg(theme.unwrap_or(Theme::Light)))
        .inner_size(1280.0, 820.0)
        .min_inner_size(380.0, 560.0)
        .on_navigation(move |url| {
          if is_app_url(url) {
            return true;
          }
          open_external(&nav, url);
          false
        })
        .on_new_window(move |url, _features| {
          open_external(&popup, &url);
          NewWindowResponse::Deny
        })
        // Llamadas: micrófono, cámara y compartir pantalla, sin volver a preguntar dentro de la app
        // (el sistema pide su permiso la primera vez). Solo para la interfaz empaquetada, nunca para otro origen.
        .on_permission_request(|webview, kind| {
          let ours = webview.url().map(|u| is_app_url(&u)).unwrap_or(false);
          match kind {
            PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::DisplayCapture if ours => PermissionResponse::Allow,
            PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::DisplayCapture => PermissionResponse::Deny,
            _ => PermissionResponse::Default,
          }
        })
        .on_download(move |_webview, event| {
          match event {
            DownloadEvent::Requested { url, destination } => {
              *destination = download_target(&dl, &url, destination);
            }
            DownloadEvent::Finished { success, .. } => {
              let body = if success { "Quedó en tu carpeta Descargas." } else { "No se pudo descargar el archivo." };
              let _ = dl.notification().builder().title("chaggu").body(body).show();
            }
            _ => {}
          }
          true
        })
        .build()?;
      // «Automático»: ya creada, la ventana sabe el tema del sistema; si es oscuro, el fondo pasa a oscuro.
      if theme.is_none() {
        if let Ok(t) = win.theme() {
          let _ = win.set_background_color(Some(theme_bg(t)));
        }
      }

      let open = MenuItem::with_id(app, "open", "Abrir chaggu", true, None::<&str>)?;
      let quit = MenuItem::with_id(app, "quit", "Salir de chaggu", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&open, &quit])?;
      TrayIconBuilder::with_id("tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("chaggu")
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, e| match e.id.as_ref() {
          "open" => show_main(app),
          "quit" => app.exit(0),
          _ => {}
        })
        .on_tray_icon_event(|tray, e| {
          if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            show_main(tray.app_handle());
          }
        })
        .build(app)?;
      Ok(())
    })
    // Cerrar la ventana la oculta: la app sigue conectada y avisando, como Slack o Teams.
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == MAIN {
          api.prevent_close();
          let _ = window.hide();
          // Si hay una llamada, la interfaz vuelve a mostrar la ventana en modo mini (siempre encima, como Meet).
          let _ = window.emit("chaggu:closed", ());
        }
      }
    })
    .build(tauri::generate_context!())
    .expect("error al iniciar chaggu");

  app.run(|app, event| {
    #[cfg(target_os = "macos")]
    if let RunEvent::Reopen { .. } = event {
      show_main(app);
    }
    let _ = (app, event);
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  fn p(s: &str) -> Option<String> {
    link_to_path(&Url::parse(s).unwrap())
  }

  #[test]
  fn enlaces() {
    assert_eq!(p("chaggu://auth/callback?code=abc&next=%2Fc%2F1").as_deref(), Some("/auth/sso?code=abc&next=%2Fc%2F1"));
    assert_eq!(p("chaggu://c/0f3a-11").as_deref(), Some("/c/0f3a-11"));
    assert_eq!(p("chaggu://").as_deref(), Some("/"));
    assert_eq!(p("https://evil.com/c/1"), None);
  }
}
