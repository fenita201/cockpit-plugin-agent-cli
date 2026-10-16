import express from 'express';

import { CHAT_UPLOAD_MAX_FILE_BYTES, CHAT_UPLOAD_MAX_FILES, CHAT_UPLOAD_MAX_TOTAL_BYTES } from '@/shared/index.js';

import {
  buildStoredAttachmentRecords,
  buildStoredImageRecords,
  openStoredAttachmentAsset,
} from '@/modules/assets/services/image-assets.service.js';
import { createAssetUpload } from './services/asset-upload.service.js';


const router = express.Router();

const upload = createAssetUpload({ field: 'images', maxFileBytes: 5 * 1024 * 1024, maxFiles: 5, imageOnly: true });
const attachmentUpload = createAssetUpload({
  field: 'files', maxFileBytes: CHAT_UPLOAD_MAX_FILE_BYTES,
  maxFiles: CHAT_UPLOAD_MAX_FILES, maxTotalBytes: CHAT_UPLOAD_MAX_TOTAL_BYTES,
});

/**
 * Stores chat image attachments in the global `~/.cloudcli/assets` folder and
 * returns their absolute paths for use in provider prompts and chat history.
 */
router.post('/images', upload, (req, res) => {
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'No image files provided' });
  }

  res.json({ images: buildStoredImageRecords(files) });
});

/**
 * Stores provider-neutral chat attachments. Files of any MIME type are
 * accepted because providers inspect them as data through their file-reading
 * tools; uploads are capped at 10 files, 50 MB per file and 100 MB per request.
 */
router.post('/files', attachmentUpload, (req, res) => {
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }

  res.json({ attachments: buildStoredAttachmentRecords(files) });
});

/**
 * Serves one stored image asset by filename. Only files directly inside the
 * global assets folder are reachable; traversal attempts resolve to null.
 */
router.get('/images/:filename', async (req, res) => {
  const asset = await openStoredAttachmentAsset(req.params.filename);
  if (asset.status === 'invalid') {
    return res.status(400).json({ error: 'Invalid asset filename' });
  }
  if (asset.status === 'missing') {
    return res.status(404).json({ error: 'Asset not found' });
  }

  res.setHeader('Content-Type', asset.contentType);
  // Stored-XSS hardening: never let the browser sniff a different type, and
  // force SVGs (which can carry scripts when rendered as a document) to
  // download instead of rendering inline. The chat UI is unaffected — it
  // fetches assets as blobs and shows them through <img>, where SVG scripts
  // never execute.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (asset.contentType === 'image/svg+xml') {
    res.setHeader('Content-Disposition', 'attachment');
  }
  asset.stream.pipe(res);
  asset.stream.on('error', (error) => {
    console.error('Error streaming image asset:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error reading asset' });
    }
  });
});

/**
 * Downloads one stored non-image attachment. Content-Disposition prevents
 * uploaded HTML or other active formats from rendering in the application.
 */
router.get('/files/:filename', async (req, res) => {
  const asset = await openStoredAttachmentAsset(req.params.filename);
  if (asset.status === 'invalid') {
    return res.status(400).json({ error: 'Invalid asset filename' });
  }
  if (asset.status === 'missing') {
    return res.status(404).json({ error: 'Asset not found' });
  }

  res.setHeader('Content-Type', asset.contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename.replace(/["\r\n]/g, '_')}"`);
  asset.stream.pipe(res);
  asset.stream.on('error', (error) => {
    console.error('Error streaming attachment asset:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error reading asset' });
    }
  });
});

export default router;
