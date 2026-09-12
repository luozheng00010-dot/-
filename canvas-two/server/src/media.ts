import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import sharp from "sharp";
import { publicBasePath } from "./config.js";
import { prisma } from "./db.js";
import { getObject, putObject, removeObject } from "./storage.js";

export const mediaResponse = (item: any) => ({ ...item, bytes: Number(item.bytes), thumbnailBytes: item.thumbnailBytes == null ? undefined : Number(item.thumbnailBytes), url: `${publicBasePath}/api/media/${item.id}/content`, thumbnailUrl: item.thumbnailObjectKey ? `${publicBasePath}/api/media/${item.id}/thumbnail` : item.mimeType?.startsWith("image/") ? `${publicBasePath}/api/media/${item.id}/content` : undefined });

async function createImageThumbnail(buffer: Buffer, mimeType: string) {
    if (!mimeType.startsWith("image/")) return null;
    try {
        const thumbnail = await sharp(buffer, { animated: false }).rotate().resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
        return thumbnail.length < buffer.length ? { buffer: thumbnail, mimeType: "image/webp" } : null;
    } catch (error) {
        console.warn("[media] Thumbnail generation failed", error);
        return null;
    }
}

export async function createUploadedThumbnail(buffer: Buffer) {
    const thumbnail = await sharp(buffer, { animated: false }).rotate().resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    return { buffer: thumbnail, mimeType: "image/webp" };
}

export async function storeMediaThumbnail(item: { id: string; objectKey: string; thumbnailObjectKey: string | null }, buffer: Buffer) {
    const thumbnail = await createUploadedThumbnail(buffer);
    const thumbnailObjectKey = item.thumbnailObjectKey || `${item.objectKey}.thumbnail.webp`;
    await putObject(thumbnailObjectKey, thumbnail.buffer, thumbnail.mimeType);
    return prisma.mediaFile.update({ where: { id: item.id }, data: { thumbnailObjectKey, thumbnailMimeType: thumbnail.mimeType, thumbnailBytes: BigInt(thumbnail.buffer.length) } });
}

export async function storeMediaBuffer(input: { ownerId: string; createdById: string; buffer: Buffer; fileName: string; mimeType: string; thumbnailBuffer?: Buffer; legacyStorageKey?: string; visibility?: "private" | "public"; origin?: string }) {
    const objectKey = `${input.ownerId}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}`;
    const thumbnail = input.thumbnailBuffer ? await createUploadedThumbnail(input.thumbnailBuffer) : await createImageThumbnail(input.buffer, input.mimeType);
    const thumbnailObjectKey = thumbnail ? `${objectKey}.thumbnail.webp` : undefined;
    await putObject(objectKey, input.buffer, input.mimeType);
    if (thumbnail && thumbnailObjectKey) await putObject(thumbnailObjectKey, thumbnail.buffer, thumbnail.mimeType);
    return prisma.mediaFile.create({ data: { ownerId: input.ownerId, createdById: input.createdById, objectKey, fileName: input.fileName, mimeType: input.mimeType, bytes: BigInt(input.buffer.length), thumbnailObjectKey, thumbnailMimeType: thumbnail?.mimeType, thumbnailBytes: thumbnail ? BigInt(thumbnail.buffer.length) : undefined, legacyStorageKey: input.legacyStorageKey, ...(input.visibility ? { visibility: input.visibility } : {}), ...(input.origin ? { origin: input.origin } : {}) } });
}

/** 彻底删除媒体：MinIO 对象（含缩略图）+ 数据库记录 */
export async function removeMediaFiles(ids: string[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return;
    const items = await prisma.mediaFile.findMany({ where: { id: { in: unique } }, select: { id: true, objectKey: true, thumbnailObjectKey: true } });
    await Promise.all(items.flatMap((item) => [removeObject(item.objectKey), ...(item.thumbnailObjectKey ? [removeObject(item.thumbnailObjectKey)] : [])]).map((operation) => operation.catch(() => undefined)));
    if (items.length) await prisma.mediaFile.deleteMany({ where: { id: { in: items.map((item) => item.id) } } }).catch(() => undefined);
}

type GeneratedImageSource = { base64?: string; url?: string; mimeType?: string };
export function generatedImageSources(payload: any): GeneratedImageSource[] {
    const standard = (payload?.data || payload?.images || payload?.results || []).flatMap((item: any) => {
        if (typeof item?.b64_json === "string" && item.b64_json) return [{ base64: item.b64_json, mimeType: item.mime_type || item.mimeType || "image/png" }];
        if (typeof item?.url === "string" && item.url) return [{ url: item.url, mimeType: item.mime_type || item.mimeType }];
        return [];
    });
    const gemini = (payload?.candidates || []).flatMap((candidate: any) => (candidate?.content?.parts || []).flatMap((part: any) => {
        const inline = part?.inlineData || part?.inline_data;
        if (typeof inline?.data === "string" && inline.data) return [{ base64: inline.data, mimeType: inline.mimeType || inline.mime_type || "image/png" }];
        const file = part?.fileData || part?.file_data;
        return typeof (file?.fileUri || file?.file_uri) === "string" ? [{ url: file.fileUri || file.file_uri, mimeType: file.mimeType || file.mime_type }] : [];
    }));
    return [...standard, ...gemini];
}

async function generatedImageBuffer(source: GeneratedImageSource) {
    if (source.base64) return { buffer: Buffer.from(source.base64, "base64"), mimeType: source.mimeType || "image/png" };
    if (!source.url) throw new Error("上游图片响应缺少内容");
    if (source.url.startsWith("data:")) {
        const matched = source.url.match(/^data:([^;,]+)?;base64,(.+)$/s);
        if (!matched) throw new Error("上游图片数据格式无效");
        return { buffer: Buffer.from(matched[2], "base64"), mimeType: matched[1] || source.mimeType || "image/png" };
    }
    const response = await fetch(source.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`下载上游图片失败（${response.status}）`);
    return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: response.headers.get("content-type")?.split(";")[0] || source.mimeType || "image/png" };
}

function imageMimeType(format?: string) {
    if (format === "jpeg" || format === "jpg") return "image/jpeg";
    if (format === "webp") return "image/webp";
    if (format === "gif") return "image/gif";
    if (format === "avif") return "image/avif";
    return "image/png";
}

export async function storeGeneratedImages(payload: unknown, ownerId: string, createdById: string, limit?: number) {
    const sources = generatedImageSources(payload).slice(0, limit);
    if (!sources.length) throw new Error("上游模型没有返回可保存的图片");
    const items = [];
    for (const [index, source] of sources.entries()) {
        const loaded = await generatedImageBuffer(source);
        const metadata = await sharp(loaded.buffer, { animated: false }).metadata();
        const mimeType = loaded.mimeType.startsWith("image/") ? loaded.mimeType : imageMimeType(metadata.format);
        const item = await storeMediaBuffer({ ownerId, createdById, buffer: loaded.buffer, fileName: `generated-${index + 1}.${metadata.format || "png"}`, mimeType });
        items.push({ ...mediaResponse(item), storageKey: `media:${item.id}`, width: metadata.width || 0, height: metadata.height || 0 });
    }
    return items;
}

export async function mediaBuffer(id: string) {
    const item = await prisma.mediaFile.findUniqueOrThrow({ where: { id } });
    const chunks: Buffer[] = [];
    for await (const chunk of await getObject(item.objectKey) as Readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return { item, buffer: Buffer.concat(chunks) };
}
