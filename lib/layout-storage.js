'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
const DEFAULT_KEY = 'store-layout/current';
const memoryObjects = new Map();

function configured() {
  return Boolean(process.env.AWS_REGION && process.env.AWS_S3_BUCKET);
}

function layoutKey() {
  const prefix = process.env.AWS_S3_LAYOUT_KEY || DEFAULT_KEY;
  if (!/^store-layout\/[a-zA-Z0-9._-]+$/.test(prefix)) {
    throw new Error('AWS_S3_LAYOUT_KEY must use the store-layout/ prefix.');
  }
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function s3Storage() {
  let client;
  const getClient = () => {
    if (!configured()) throw new Error('S3 layout storage is not configured.');
    if (!client) client = new S3Client({ region: process.env.AWS_REGION });
    return client;
  };
  return {
    isConfigured: configured,
    async upload({ body, contentType }) {
      if (!IMAGE_TYPES.has(contentType)) throw new Error('Unsupported layout image type.');
      const key = layoutKey();
      await getClient().send(new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'no-store'
      }));
      return { key, contentType, size: body.length };
    },
    async get(key) {
      const response = await getClient().send(new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: key }));
      return { body: Buffer.from(await response.Body.transformToByteArray()), contentType: response.ContentType || 'application/octet-stream' };
    }
  };
}

function memoryStorage() {
  return {
    isConfigured: () => true,
    async upload({ body, contentType }) {
      if (!IMAGE_TYPES.has(contentType)) throw new Error('Unsupported layout image type.');
      if (process.env.LAYOUT_STORAGE_FAIL_UPLOAD === '1') throw new Error('Layout upload failed.');
      const key = DEFAULT_KEY;
      memoryObjects.set(key, { body: Buffer.from(body), contentType });
      return { key, contentType, size: body.length };
    },
    async get(key) {
      const object = memoryObjects.get(key);
      if (!object) throw new Error('Layout image was not found.');
      return { body: Buffer.from(object.body), contentType: object.contentType };
    }
  };
}

function getLayoutStorage(type = process.env.LAYOUT_STORAGE_TYPE || 's3') {
  if (type === 's3') return s3Storage();
  if (type === 'memory') return memoryStorage();
  throw new Error(`Unknown layout storage type: ${type}`);
}

module.exports = { getLayoutStorage, IMAGE_TYPES };
