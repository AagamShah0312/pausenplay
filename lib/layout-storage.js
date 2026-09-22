'use strict';
const { GridFSBucket, ObjectId } = require('mongodb');
const { connectMongo } = require('./mongodb');
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
const memoryObjects = new Map();

function gridfs() {
  const getBucket = async () => new GridFSBucket(await connectMongo(), { bucketName: 'fs' });
  return {
    isConfigured: () => true,
    async upload({ body, contentType }) {
      if (!IMAGE_TYPES.has(contentType)) throw new Error('Unsupported layout image type.');
      const stream = (await getBucket()).openUploadStream(`store-layout-${Date.now()}`, { contentType, metadata: { purpose: 'store-layout' } });
      await new Promise((resolve, reject) => { stream.once('error', reject); stream.once('finish', resolve); stream.end(body); });
      return { fileId: stream.id.toString(), contentType, size: body.length };
    },
    async get(fileId) {
      if (!ObjectId.isValid(fileId)) throw new Error('Layout image was not found.');
      const db = await connectMongo();
      const file = await db.collection('fs.files').findOne({ _id: new ObjectId(fileId) });
      if (!file) throw new Error('Layout image was not found.');
      return { stream: new GridFSBucket(db, { bucketName: 'fs' }).openDownloadStream(file._id), contentType: file.contentType || 'application/octet-stream', length: file.length };
    },
    async remove(fileId) { if (ObjectId.isValid(fileId)) await (await getBucket()).delete(new ObjectId(fileId)); }
  };
}
function memory() {
  return {
    isConfigured: () => true,
    async upload({ body, contentType }) { if (!IMAGE_TYPES.has(contentType)) throw new Error('Unsupported layout image type.'); if (process.env.LAYOUT_STORAGE_FAIL_UPLOAD === '1') throw new Error('Layout upload failed.'); const fileId = `memory-${Date.now()}-${Math.random()}`; memoryObjects.set(fileId, { body: Buffer.from(body), contentType }); return { fileId, contentType, size: body.length }; },
    async get(fileId) { const value = memoryObjects.get(fileId); if (!value) throw new Error('Layout image was not found.'); return { body: Buffer.from(value.body), contentType: value.contentType, length: value.body.length }; },
    async remove(fileId) { memoryObjects.delete(fileId); }
  };
}
function getLayoutStorage(type = process.env.LAYOUT_STORAGE_TYPE || 'gridfs') { if (type === 'gridfs') return gridfs(); if (type === 'memory') return memory(); throw new Error(`Unknown layout storage type: ${type}`); }
module.exports = { getLayoutStorage, IMAGE_TYPES };
