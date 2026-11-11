import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';

/** A file read from a multipart form, before the guards run. */
export type Upload = { buffer: Buffer; size: number; originalname: string };
export type UploadRequest = Request & { file?: Upload; uploadIssue?: string };

/**
 * Reads a multipart form with one file into memory before the guards run,
 * so the CSRF check sees its fields (put _csrf before the file in the form).
 * A file over the limit is not an error page: the route reports it.
 */
export function fileUpload(field: string, maxBytes: number, tooBig: string) {
  const single = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1, fields: 6, fieldSize: 1024, parts: 8 } }).single(field);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST' || !req.is('multipart/form-data')) return next();
    single(req, res, (err?: unknown) => {
      if (err) (req as UploadRequest).uploadIssue = (err as { code?: string }).code === 'LIMIT_FILE_SIZE' ? tooBig : 'The upload could not be read. Try again with one file.';
      next();
    });
  };
}
