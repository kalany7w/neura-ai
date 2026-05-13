import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env';
import { logger } from '../logger';

const protocol = env.MINIO_USE_SSL ? 'https' : 'http';
const endpoint = `${protocol}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`;

export const s3 = new S3Client({
  endpoint,
  region: 'us-east-1',
  credentials: {
    accessKeyId: env.MINIO_ACCESS_KEY,
    secretAccessKey: env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true, // MinIO usa path style
});

let bucketEnsured = false;

export async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.MINIO_BUCKET }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: env.MINIO_BUCKET }));
      logger.info({ bucket: env.MINIO_BUCKET }, 'MinIO bucket created');
    } catch (err) {
      logger.error({ err }, 'Failed to ensure MinIO bucket');
      throw err;
    }
  }
  bucketEnsured = true;
}

export interface PresignUploadParams {
  workspaceId: string;
  filename: string;
  contentType: string;
  /** Tamanho em bytes — usado pra escolher TTL (mais tempo pra arquivos grandes) */
  size?: number;
}

export interface PresignedUpload {
  uploadUrl: string;
  key: string;
  publicUrl: string;
  expiresIn: number;
}

export async function presignUpload(params: PresignUploadParams): Promise<PresignedUpload> {
  await ensureBucket();
  const safeFilename = params.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `accounts/${params.workspaceId}/uploads/${Date.now()}-${safeFilename}`;
  const cmd = new PutObjectCommand({
    Bucket: env.MINIO_BUCKET,
    Key: key,
    ContentType: params.contentType,
  });
  const expiresIn = 60 * 15; // 15min
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn });
  const publicUrl = `${endpoint}/${env.MINIO_BUCKET}/${key}`;
  return { uploadUrl, key, publicUrl, expiresIn };
}

export async function presignDownload(key: string, expiresInSec = 3600): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: expiresInSec });
}
