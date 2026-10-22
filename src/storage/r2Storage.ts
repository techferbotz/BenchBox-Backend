import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config, R2Config } from "../config/env";
import { ListedObject, ObjectStore, Page, UploadedPart } from "./objectStore";

// Cloudflare R2 through its S3 API. The ONLY importer of the AWS SDK (one SDK, one file).
//
// Two R2-specific settings matter:
//   - Checksums only WHEN_REQUIRED. Since SDK 3.729 the default adds CRC32 checksum parameters,
//     which would get baked into presigned URLs and make the app's plain PUTs fail.
//   - Path-style URLs (https://<account>.r2.cloudflarestorage.com/<bucket>/<key>), which R2 and any
//     local S3 stand-in accept alike.
//
// Presigning is a local HMAC: no network call, so issuing a URL costs next to nothing.

const isMissing = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.name === "NoSuchUpload" || e?.$metadata?.httpStatusCode === 404;
};

export const createR2Store = (cfg: R2Config): ObjectStore => {
  const client = new S3Client({
    region: "auto", // required by the SDK, ignored by R2
    endpoint: cfg.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
    // A storage outage must fail a request, not hang it.
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
  });
  const Bucket = cfg.bucket;
  // Sign Content-Length, so a presigned upload can only carry the bytes it was issued for.
  const lengthSigned = (expiresIn: number) => ({ expiresIn, signableHeaders: new Set(["content-length"]) });

  return {
    bucket: Bucket,

    presignPut: (Key, ContentLength, expiresIn) =>
      getSignedUrl(client, new PutObjectCommand({ Bucket, Key, ContentLength }), lengthSigned(expiresIn)),

    presignUploadPart: (Key, UploadId, PartNumber, ContentLength, expiresIn) =>
      getSignedUrl(client, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, ContentLength }), lengthSigned(expiresIn)),

    presignGet: (Key, expiresIn, response) =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket,
          Key,
          ResponseContentType: response.contentType,
          ResponseContentDisposition: response.contentDisposition,
        }),
        { expiresIn }
      ),

    async createMultipartUpload(Key) {
      const out = await client.send(new CreateMultipartUploadCommand({ Bucket, Key }));
      if (!out.UploadId) throw new Error("R2 returned no UploadId");
      return out.UploadId;
    },

    async listParts(Key, UploadId) {
      const parts: UploadedPart[] = [];
      let marker: string | undefined;
      try {
        for (;;) {
          const out = await client.send(
            new ListPartsCommand({ Bucket, Key, UploadId, MaxParts: 1000, PartNumberMarker: marker })
          );
          for (const p of out.Parts ?? []) {
            if (p.PartNumber !== undefined && p.Size !== undefined && p.ETag) {
              parts.push({ partNumber: p.PartNumber, size: p.Size, etag: p.ETag });
            }
          }
          if (!out.IsTruncated || !out.NextPartNumberMarker) break;
          marker = out.NextPartNumberMarker;
        }
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
      return parts.sort((a, b) => a.partNumber - b.partNumber);
    },

    async completeMultipartUpload(Key, UploadId, parts) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key,
          UploadId,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
        })
      );
    },

    async abortMultipartUpload(Key, UploadId) {
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    },

    async headObject(Key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key }));
        return { size: out.ContentLength ?? 0 };
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },

    async deleteObjects(keys) {
      if (keys.length === 0) return;
      if (keys.length > 1000) throw new Error("deleteObjects takes at most 1000 keys");
      const out = await client.send(
        new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } })
      );
      const failed = out.Errors ?? [];
      if (failed.length > 0) {
        throw new Error(`R2 could not delete ${failed.length} object(s): ${failed[0]?.Code ?? "unknown error"}`);
      }
    },

    async listObjects(Prefix, next) {
      const out = await client.send(
        new ListObjectsV2Command({ Bucket, Prefix, MaxKeys: 1000, ContinuationToken: next ?? undefined })
      );
      const items: ListedObject[] = (out.Contents ?? []).flatMap((o) =>
        o.Key ? [{ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) }] : []
      );
      return { items, next: out.IsTruncated ? (out.NextContinuationToken ?? null) : null };
    },

    async listPrefixes(Prefix, next) {
      const out = await client.send(
        new ListObjectsV2Command({ Bucket, Prefix, Delimiter: "/", MaxKeys: 1000, ContinuationToken: next ?? undefined })
      );
      const items = (out.CommonPrefixes ?? []).flatMap((p) => (p.Prefix ? [p.Prefix] : []));
      return { items, next: out.IsTruncated ? (out.NextContinuationToken ?? null) : null };
    },

    async listMultipartUploads(Prefix, next) {
      const [KeyMarker, UploadIdMarker] = next ? (JSON.parse(next) as [string, string]) : [undefined, undefined];
      const out = await client.send(new ListMultipartUploadsCommand({ Bucket, Prefix, KeyMarker, UploadIdMarker }));
      const items = (out.Uploads ?? []).flatMap((u) => (u.Key && u.UploadId ? [{ key: u.Key, uploadId: u.UploadId }] : []));
      const more: Page<unknown>["next"] = out.IsTruncated
        ? JSON.stringify([out.NextKeyMarker ?? "", out.NextUploadIdMarker ?? ""])
        : null;
      return { items, next: more };
    },
  };
};

/** The configured store, or null when R2 isn't set up (the file endpoints then answer 503). */
export const objectStore: ObjectStore | null = config.r2 ? createR2Store(config.r2) : null;
