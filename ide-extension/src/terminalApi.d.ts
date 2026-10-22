import "vscode";
declare module "vscode" {
  interface TerminalDataWriteEvent { readonly terminal: Terminal; readonly data: string }
  interface TerminalDimensionsChangeEvent { readonly terminal: Terminal; readonly dimensions: TerminalDimensions }
  interface Terminal { readonly dimensions: TerminalDimensions | undefined }
  namespace window {
    const onDidWriteTerminalData: Event<TerminalDataWriteEvent>;
    const onDidChangeTerminalDimensions: Event<TerminalDimensionsChangeEvent>;
  }
}
