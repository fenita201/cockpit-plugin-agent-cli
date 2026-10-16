import assert from 'node:assert/strict';
import test from 'node:test';

import { unlink } from 'node:fs/promises';
import express from 'express';
import { decodeMultipartFilename } from '@/shared/index.js';

import { createAssetUpload } from '../services/asset-upload.service.js';

test('multipart filename decoding preserves Vietnamese, Unicode and legacy Latin-1', () => {
  const name = 'tài liệu tiếng Việt miền nam.txt';
  assert.equal(decodeMultipartFilename(Buffer.from(name).toString('latin1')), name);
  assert.equal(decodeMultipartFilename(name), name);
  assert.equal(decodeMultipartFilename('café.txt'), 'café.txt');
  assert.equal(decodeMultipartFilename('plain.txt'), 'plain.txt');
  assert.equal(decodeMultipartFilename('📁.txt'), '📁.txt');
});

test('multipart transport preserves names and rejects per-file, count and total limits', async () => {
  const app = express();
  app.post('/', createAssetUpload({ field: 'files', maxFileBytes: 32, maxFiles: 2, maxTotalBytes: 40 }), async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    const result = files.map((file) => ({ name: file.originalname, size: file.size }));
    await Promise.all(files.map((file) => unlink(file.path)));
    res.json(result);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const send = (sizes: number[]) => {
    const body = new FormData();
    for (const size of sizes) body.append('files', new Blob(['x'.repeat(size)]), 'tài liệu tiếng Việt.txt');
    return fetch(`http://127.0.0.1:${address.port}/`, { method: 'POST', body });
  };
  try {
    const success = await send([20, 20]);
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), [
      { name: 'tài liệu tiếng Việt.txt', size: 20 }, { name: 'tài liệu tiếng Việt.txt', size: 20 },
    ]);
    assert.equal((await send([33])).status, 413);
    assert.equal((await send([21, 20])).status, 413);
    assert.equal((await send([1, 1, 1])).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
