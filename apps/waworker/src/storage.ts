import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { env } from './env.js';
import { logger } from './logger.js';

const protocol = env.MINIO_USE_SSL ? 'https' : 'http';
const endpoint = `${protocol}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`;

export const s3 = new S3Client({
  endpoint,
  region: 'us-east-1',
  credentials: {
    accessKeyId: env.MINIO_ACCESS_KEY,
    secretAccessKey: env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true,
});

export const BUCKET = env.MINIO_BUCKET;

export async function putMedia(key: string, buffer: Buffer, contentType: string): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );
  return `${endpoint}/${BUCKET}/${key}`;
}

export async function getMediaBuffer(key: string): Promise<Buffer> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!obj.Body) throw new Error(`Empty body for ${key}`);
  const bytes = await obj.Body.transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * Extrai a key de uma URL pública do MinIO (ex: http://host:9000/bucket/key).
 */
export function keyFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const idx = parsed.pathname.indexOf(`/${BUCKET}/`);
    if (idx === -1) return null;
    return decodeURIComponent(parsed.pathname.slice(idx + BUCKET.length + 2));
  } catch (err) {
    logger.warn({ err, url }, 'Failed to extract S3 key from URL');
    return null;
  }
}
