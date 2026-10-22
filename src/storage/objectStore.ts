// What BrimBox needs from object storage (deviation D2). The one implementation is r2Storage.ts,
// the sole importer of the AWS SDK; services take an ObjectStore as a constructor dependency, which
// is how check:storage-db runs them against an in-memory store with no network.
//
// Sizes are plain numbers: the largest object R2 accepts (~5 TiB) is far inside Number's exact range.

export interface UploadedPart {
  partNumber: number;
  size: number;
  etag: string;
}

export interface ListedObject {
  key: string;
  size: number;
  lastModified: Date;
}

export interface Page<T> {
  items: T[];
  /** Pass back to continue; null when this was the last page. */
  next: string | null;
}

export interface ObjectStore {
  readonly bucket: string;

  /**
   * A presigned PUT for the whole object. The length is SIGNED: the upload must be exactly
   * `contentLength` bytes, sent with a Content-Length header (not chunked), or R2 rejects it.
   */
  presignPut(key: string, contentLength: number, expiresInSeconds: number): Promise<string>;
  /** A presigned UploadPart, its length signed the same way. */
  presignUploadPart(key: string, uploadId: string, partNumber: number, contentLength: number, expiresInSeconds: number): Promise<string>;
  /** A presigned GET whose response carries these headers (object keys hold no names or types). */
  presignGet(key: string, expiresInSeconds: number, response: { contentType: string; contentDisposition?: string }): Promise<string>;

  /** Starts a multipart upload; returns R2's upload id. */
  createMultipartUpload(key: string): Promise<string>;
  /** Every part uploaded so far, by part number. Null when R2 no longer knows the upload (completed or aborted). */
  listParts(key: string, uploadId: string): Promise<UploadedPart[] | null>;
  completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  /** Already completed or aborted counts as done. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  /** The object's size, or null if there is no such object. */
  headObject(key: string): Promise<{ size: number } | null>;
  /** Up to 1000 keys. Keys that don't exist count as deleted. */
  deleteObjects(keys: string[]): Promise<void>;

  /** One page (≤ 1000) of the objects under `prefix`, in key order. */
  listObjects(prefix: string, next?: string | null): Promise<Page<ListedObject>>;
  /** One page of the "folders" directly under `prefix` (delimiter "/"), each ending in "/". */
  listPrefixes(prefix: string, next?: string | null): Promise<Page<string>>;
  /** One page of the unfinished multipart uploads under `prefix`. */
  listMultipartUploads(prefix: string, next?: string | null): Promise<Page<{ key: string; uploadId: string }>>;
}
