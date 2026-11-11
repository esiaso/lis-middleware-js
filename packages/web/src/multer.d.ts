// multer 2.5.0 ships no type declarations; this covers the parts used here.
declare module 'multer' {
  import type { RequestHandler } from 'express';
  interface Limits { fileSize?: number; files?: number; fields?: number; fieldSize?: number; parts?: number }
  interface Instance { single(field: string): RequestHandler }
  interface Multer {
    (opts: { storage: unknown; limits?: Limits }): Instance;
    memoryStorage(): unknown;
  }
  const multer: Multer;
  export default multer;
}
