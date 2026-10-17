// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|v| v == "--claude-statusline") {
        if let Some(path) = args.get(2) {
            // Status-line failures must never start a desktop window.
            let _ = codex_switcher_lib::auth::claude_usage::run_statusline(std::path::Path::new(path));
        }
        return;
    }
    if std::env::args().any(|arg| arg == "--mcp") {
        if let Err(error) = codex_switcher_lib::mcp::run_stdio() {
            eprintln!("Account Switcher MCP: {error}");
            std::process::exit(1);
        }
        return;
    }
    codex_switcher_lib::run()
}
