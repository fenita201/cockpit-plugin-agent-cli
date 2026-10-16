import { unlink } from 'node:fs/promises';
import multer from 'multer';
import type { RequestHandler } from 'express';

import { decodeMultipartFilename } from '@/shared/index.js';

import { ensureImageAssetsDir, isAllowedImageMimeType } from './image-assets.service.js';

/** Assets routes use this middleware to store files and enforce upload budgets. */
export function createAssetUpload(options: {
  field: string;
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes?: number;
  imageOnly?: boolean;
}): RequestHandler {
  const storage = multer.diskStorage({
    destination: (_req, _file, callback) => {
      ensureImageAssetsDir().then((directory) => callback(null, directory))
        .catch((error: Error) => callback(error, ''));
    },
    filename: (_req, file, callback) => {
      file.originalname = decodeMultipartFilename(file.originalname);
      const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
      callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${sanitizedName}`);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: options.maxFileBytes, files: options.maxFiles },
    fileFilter: (_req, file, callback) => {
      if (!options.imageOnly || isAllowedImageMimeType(file.mimetype)) callback(null, true);
      else callback(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
    },
  }).array(options.field, options.maxFiles);

  return (request, response, next) => {
    upload(request, response, (error: unknown) => {
      // Multer removes partial uploads itself when it rejects size/count limits.
      if (error) {
        const code = error instanceof multer.MulterError ? error.code : '';
        const message = code === 'LIMIT_FILE_SIZE'
          ? `File too large (max ${options.maxFileBytes / 1024 / 1024} MB per file).`
          : code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_UNEXPECTED_FILE'
            ? `Too many files (max ${options.maxFiles}).`
            : error instanceof Error ? error.message : 'Upload failed';
        response.status(code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
        return;
      }
      const files = Array.isArray(request.files) ? request.files : [];
      const total = files.reduce((sum, file) => sum + file.size, 0);
      if (options.maxTotalBytes !== undefined && total > options.maxTotalBytes) {
        // Remove the completed batch too; rejected attachments must not accumulate.
        void Promise.all(files.map((file) => unlink(file.path))).then(() => {
          response.status(413).json({
            error: `Attachments too large (max ${options.maxTotalBytes! / 1024 / 1024} MB total).`,
          });
        }).catch(next);
        return;
      }
      next();
    });
  };
}
