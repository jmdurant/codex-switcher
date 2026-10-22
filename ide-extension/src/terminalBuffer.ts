import * as vscode from "vscode";
import { TerminalScreen, type TerminalSnapshot } from "./terminalScreen";

const screens = new Map<vscode.Terminal, TerminalScreen>();
let rawOutputAvailable = false;

function screen(terminal: vscode.Terminal): TerminalScreen {
  let value = screens.get(terminal);
  if (!value) {
    let dimensions: vscode.TerminalDimensions | undefined;
    try { dimensions = terminal.dimensions; } catch { /* Only the data proposal may be enabled. */ }
    value = new TerminalScreen(dimensions?.columns, dimensions?.rows);
    screens.set(terminal, value);
  }
  return value;
}

export function observeTerminalOutput(terminal: vscode.Terminal, data: string): void {
  if (!rawOutputAvailable) screen(terminal).write(data);
}

export function startTerminalObservation(context: vscode.ExtensionContext, log: (message: string) => void): void {
  try {
    const event = vscode.window.onDidWriteTerminalData;
    if (!event) throw new Error("Terminal output event unavailable");
    context.subscriptions.push(event(({terminal, data}) => screen(terminal).write(data)));
    rawOutputAvailable = true;
    log("Silent terminal output observation enabled, including restored terminals.");
  } catch {
    log("Restored-terminal output API unavailable. Start the editor with --enable-proposed-api jmdurant.ai-account-switcher-resume; fresh shell executions are still observed.");
  }
  try {
    if (vscode.window.onDidChangeTerminalDimensions) context.subscriptions.push(vscode.window.onDidChangeTerminalDimensions(({terminal, dimensions}) => screens.get(terminal)?.resize(dimensions.columns, dimensions.rows)));
  } catch { /* Fixed dimensions still render fresh shell output. */ }
  context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
    screens.get(terminal)?.dispose(); screens.delete(terminal);
  }));
  context.subscriptions.push({dispose() {
    for (const value of screens.values()) value.dispose();
    screens.clear(); rawOutputAvailable = false;
  }});
}

export async function readTerminalBuffer(terminal: vscode.Terminal): Promise<TerminalSnapshot | undefined> {
  return screens.get(terminal)?.snapshot();
}
