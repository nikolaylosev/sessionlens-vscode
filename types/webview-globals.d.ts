/* Globals of the panel page (phase 7, 7B.6): the other media/*.js scripts define them before app.js runs, and
   vscode-bridge.js defines the window.__sl* functions. Typed loosely on purpose: the check is for mistakes such as
   misspelled names and wrong arities, not for the shape of every structure. */
declare const Lens: any;
declare const LensChecks: any;
declare const LensLint: any;
declare const LensRules: any;
declare const LensSpec: any;
declare const LensAI: any;
declare const LensSeg: any;
declare const LensLintRobot: any;
declare const LensLintCore: any;
declare const LensLintCypress: any;
declare const LensLintDetox: any;
declare const LensLintJava: any;
declare const LensLintCSharp: any;
declare const LensLintPython: any;
declare const TreeSitter: any;
declare const chrome: any;
declare const I18N: any;
declare function alertDialog(message: string): Promise<void>;
declare function confirmDialog(message: string, ...rest: any[]): Promise<boolean>;
declare function promptDialog(message: string, ...rest: any[]): Promise<string | null>;
declare function chooseDialog(message: string, ...rest: any[]): Promise<any>;
declare function acquireVsCodeApi(): { postMessage(message: any): void; setState(state: any): void; getState(): any };

interface Window {
  [key: `__sl${string}`]: any;
  [key: `SL_${string}`]: any;
  chrome: any;
  LensAI: any;
  I18N: any;
}

/* the Node side of the tree-sitter engines (tests load them with require) */
declare module "web-tree-sitter";
