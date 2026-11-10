// hbs 4.4.0 ships no type declarations; this covers the parts used here.
declare module 'hbs' {
  type Helper = (...args: never[]) => unknown;
  interface HbsInstance {
    __express: (path: string, options: object, cb: (err: Error | null, html?: string) => void) => void;
    registerHelper(name: string, fn: Helper): void;
    registerPartial(name: string, template: string): void;
    handlebars: { SafeString: new (s: string) => object };
  }
  const hbs: HbsInstance & { create(): HbsInstance };
  export default hbs;
}
