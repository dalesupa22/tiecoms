// Envoltura de escritorio (macOS y Windows) sobre la web de TieComs.
// Siguiente paso: plugins de notificaciones, deep links (tiecoms://) y actualizador firmado.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error al iniciar TieComs");
}
