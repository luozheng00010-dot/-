import { Client } from "minio";
import { env } from "./config.js";

export const minio = new Client({
    endPoint: env.MINIO_ENDPOINT,
    port: env.MINIO_PORT,
    useSSL: env.MINIO_USE_SSL === "true",
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
});

export async function ensureBucket() {
    if (!(await minio.bucketExists(env.MINIO_BUCKET))) await minio.makeBucket(env.MINIO_BUCKET);
}

export function putObject(key: string, value: Buffer, mimeType: string) {
    return minio.putObject(env.MINIO_BUCKET, key, value, value.length, { "Content-Type": mimeType });
}

export function getObject(key: string) {
    return minio.getObject(env.MINIO_BUCKET, key);
}

export function getPartialObject(key: string, offset: number, length: number) {
    return minio.getPartialObject(env.MINIO_BUCKET, key, offset, length);
}

export function removeObject(key: string) {
    return minio.removeObject(env.MINIO_BUCKET, key);
}
