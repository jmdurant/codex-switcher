// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--mcp") {
        if let Err(error) = codex_switcher_lib::mcp::run_stdio() {
            eprintln!("Account Switcher MCP: {error}");
            std::process::exit(1);
        }
        return;
    }
    codex_switcher_lib::run()
}
