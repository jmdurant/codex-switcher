//! AI Account Switcher - Multi-account manager for AI coding tools

pub mod api;
#[cfg(desktop)]
pub mod app_menu;
pub mod auth;
pub mod commands;
#[cfg(desktop)]
pub mod tray;
pub mod types;
pub mod web;

use commands::{
    ack_close_behavior_prompt, add_account_from_file, cancel_login,
    capture_current_antigravity_account, check_antigravity_processes, check_codex_processes,
    complete_close_behavior, complete_ide_resume, complete_login, delete_account,
    delete_antigravity_account, export_accounts_full_encrypted_file, export_accounts_slim_text,
    get_account_usage_stats, get_active_account_info, get_antigravity_usage, get_app_settings,
    get_dock_display_mode, get_masked_account_ids, get_usage, hide_tray_window,
    import_accounts_full_encrypted_file, import_accounts_slim_text, kill_antigravity_processes,
    kill_codex_processes, list_accounts, list_antigravity_accounts, open_main_window,
    prepare_ide_resume, quit_app, refresh_account_metadata, refresh_all_accounts_usage,
    rename_account, report_usage, set_app_settings, set_dock_display_mode, set_masked_account_ids,
    start_login, start_relogin, switch_account, switch_antigravity_account, warmup_account,
    warmup_all_accounts,
};
use tauri::Emitter;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app_menu::setup(app.handle())?;
                tray::setup(app.handle())?;

                // Apply start-minimized setting: hide the main window on startup.
                let settings = auth::load_app_settings().unwrap_or_default();
                if settings.start_minimized {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    #[cfg(target_os = "macos")]
                    if commands::should_prompt_for_close_behavior() {
                        let payload = commands::window::next_close_behavior_prompt_payload();
                        let app_handle = tauri::Manager::app_handle(window);
                        commands::window::schedule_close_behavior_prompt_fallback(
                            app_handle.clone(),
                            payload.request_id,
                        );
                        let _ =
                            window.emit(commands::window::CLOSE_BEHAVIOR_REQUESTED_EVENT, payload);
                        return;
                    }
                    commands::hide_main_window(&tauri::Manager::app_handle(window));
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_codex_app,
            // Account management
            list_accounts,
            commands::get_current_codex_login,
            commands::capture_current_codex_login,
            get_active_account_info,
            add_account_from_file,
            switch_account,
            delete_account,
            rename_account,
            list_antigravity_accounts,
            capture_current_antigravity_account,
            check_antigravity_processes,
            switch_antigravity_account,
            delete_antigravity_account,
            get_antigravity_usage,
            kill_antigravity_processes,
            export_accounts_slim_text,
            import_accounts_slim_text,
            export_accounts_full_encrypted_file,
            import_accounts_full_encrypted_file,
            // Masked accounts
            get_masked_account_ids,
            set_masked_account_ids,
            // OAuth
            start_login,
            start_relogin,
            complete_login,
            cancel_login,
            // Usage
            get_usage,
            get_account_usage_stats,
            refresh_account_metadata,
            refresh_all_accounts_usage,
            warmup_account,
            warmup_all_accounts,
            // Process detection
            check_codex_processes,
            kill_codex_processes,
            prepare_ide_resume,
            complete_ide_resume,
            // Tray window
            hide_tray_window,
            open_main_window,
            quit_app,
            report_usage,
            get_dock_display_mode,
            set_dock_display_mode,
            complete_close_behavior,
            ack_close_behavior_prompt,
            // App settings (open-after-switch, launch-at-login, start-minimized)
            get_app_settings,
            set_app_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                commands::restore_main_window(_app);
            }
        });
}
