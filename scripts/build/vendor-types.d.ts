declare module "electron-to-chromium" {
  export const versions: Record<string, string>;
}

declare module "js-beautify" {
  export interface JsBeautifyOptions {
    indent_size?: number;
  }

  export function js(source: string, options?: JsBeautifyOptions): string;

  const beautify: {
    js: typeof js;
  };

  export default beautify;
}
