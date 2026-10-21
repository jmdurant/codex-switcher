import * as vscode from "vscode";

let reading: Promise<unknown> = Promise.resolve();

/** Read the editor's live xterm accessibility model without using the clipboard.
 * Accessible View is a local, read-only editor command and also works for
 * persistent terminals whose shell execution event predates this extension host.
 */
export function readTerminalBuffer(terminal: vscode.Terminal): Promise<string | undefined> {
  const result = reading.then(async () => {
    if (!vscode.window.terminals.includes(terminal)) return;
    const previousTerminal = vscode.window.activeTerminal;
    const previousEditor = vscode.window.activeTextEditor;
    try {
      terminal.show(true);
      // The active-terminal event crosses the extension-host boundary.
      for (let attempt = 0; attempt < 20 && vscode.window.activeTerminal !== terminal; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (vscode.window.activeTerminal !== terminal) return;
      await vscode.commands.executeCommand("workbench.action.terminal.focusAccessibleBuffer");
      if (vscode.window.activeTerminal !== terminal) return;
      await new Promise(resolve => setTimeout(resolve, 20));
      for (let attempt = 0; attempt < 20; attempt++) {
        const document = vscode.window.activeTextEditor?.document;
        if (document?.uri.scheme === "accessible-view" && document.uri.path === "accessible-view-terminal") {
          return document.getText();
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } catch {
      return undefined;
    } finally {
      if (vscode.window.activeTerminal === terminal) {
        if (previousTerminal && vscode.window.terminals.includes(previousTerminal)) previousTerminal.show(true);
        if (previousEditor && previousEditor.document.uri.scheme !== "accessible-view") {
          await vscode.window.showTextDocument(previousEditor.document, { viewColumn: previousEditor.viewColumn, preserveFocus: false });
        } else {
          await vscode.commands.executeCommand("workbench.action.terminal.focus");
        }
      }
    }
  });
  reading = result.catch(() => undefined);
  return result;
}
