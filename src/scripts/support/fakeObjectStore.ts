import { ListedObject, ObjectStore, Page, UploadedPart } from "../../storage/objectStore";

// An in-memory ObjectStore for check:storage-db: R2's behaviour as far as BenchBox relies on it, and
// the app's side too — `put` performs what the app does with a presigned URL, refusing a body
// whose length differs from the signed one, as R2 would.

interface MultipartUpload {
  key: string;
  parts: Map<number, UploadedPart>;
}

type Method = keyof ObjectStore;

export class FakeObjectStore implements ObjectStore {
  readonly bucket = "check-bucket";
  readonly objects = new Map<string, { size: number; lastModified: Date }>();
  readonly multipart = new Map<string, MultipartUpload>();
  private sequence = 0;
  private failures = new Map<string, number>();

  /** Make the next `times` calls of `method` throw, like an R2 outage. */
  failNext(method: Method, times = 1): void {
    this.failures.set(method, times);
  }

  private maybeFail(method: Method): void {
    const left = this.failures.get(method) ?? 0;
    if (left > 0) {
      this.failures.set(method, left - 1);
      const err = new Error(`fake ${method} failure`);
      err.name = "InternalError";
      throw err;
    }
  }

  // ---------------------------------------------------------------- presigning (local, like R2's)

  async presignPut(key: string, contentLength: number, expiresIn: number): Promise<string> {
    return `fake://put/${key}?length=${contentLength}&expires=${expiresIn}`;
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number, contentLength: number, expiresIn: number): Promise<string> {
    return `fake://part/${key}?upload=${uploadId}&part=${partNumber}&length=${contentLength}&expires=${expiresIn}`;
  }

  async presignGet(key: string, expiresIn: number, response: { contentType: string; contentDisposition?: string }): Promise<string> {
    const query = new URLSearchParams({ expires: String(expiresIn), type: response.contentType });
    if (response.contentDisposition) query.set("disposition", response.contentDisposition);
    return `fake://get/${key}?${query.toString()}`;
  }

  // ---------------------------------------------------------------- the app's side

  /** What the app does with a presigned PUT URL: send exactly `size` bytes. */
  put(url: string, size: number): void {
    const parsed = new URL(url);
    const key = parsed.pathname.replace(/^\//, "");
    const signed = Number(parsed.searchParams.get("length"));
    if (size !== signed) throw new Error(`SignatureDoesNotMatch: ${size} bytes sent, ${signed} signed`);
    if (parsed.host === "put") {
      this.objects.set(key, { size, lastModified: new Date() });
    } else if (parsed.host === "part") {
      const upload = this.multipart.get(parsed.searchParams.get("upload") ?? "");
      if (!upload || upload.key !== key) throw new Error("NoSuchUpload");
      const partNumber = Number(parsed.searchParams.get("part"));
      upload.parts.set(partNumber, { partNumber, size, etag: `"${key}-${partNumber}-${size}"` });
    } else {
      throw new Error(`not an upload URL: ${url}`);
    }
  }

  /** A part of any size, bypassing the signature — what a buggy client or a lost byte would leave. */
  putPartUnsigned(uploadId: string, partNumber: number, size: number): void {
    const upload = this.multipart.get(uploadId);
    if (!upload) throw new Error("NoSuchUpload");
    upload.parts.set(partNumber, { partNumber, size, etag: `"raw-${partNumber}-${size}"` });
  }

  // ---------------------------------------------------------------- S3 operations

  async createMultipartUpload(key: string): Promise<string> {
    this.maybeFail("createMultipartUpload");
    const id = `mp-${++this.sequence}`;
    this.multipart.set(id, { key, parts: new Map() });
    return id;
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[] | null> {
    this.maybeFail("listParts");
    const upload = this.multipart.get(uploadId);
    if (!upload || upload.key !== key) return null;
    return [...upload.parts.values()].sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    this.maybeFail("completeMultipartUpload");
    const upload = this.multipart.get(uploadId);
    if (!upload || upload.key !== key) throw Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" });
    let size = 0;
    for (const { partNumber, etag } of parts) {
      const part = upload.parts.get(partNumber);
      if (!part || part.etag !== etag) throw new Error(`InvalidPart ${partNumber}`);
      size += part.size;
    }
    this.objects.set(key, { size, lastModified: new Date() });
    this.multipart.delete(uploadId);
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.maybeFail("abortMultipartUpload");
    this.multipart.delete(uploadId);
  }

  async headObject(key: string): Promise<{ size: number } | null> {
    this.maybeFail("headObject");
    const object = this.objects.get(key);
    return object ? { size: object.size } : null;
  }

  async deleteObjects(keys: string[]): Promise<void> {
    this.maybeFail("deleteObjects");
    if (keys.length > 1000) throw new Error("MalformedXML: more than 1000 keys");
    for (const key of keys) this.objects.delete(key);
  }

  async listObjects(prefix: string, next?: string | null): Promise<Page<ListedObject>> {
    this.maybeFail("listObjects");
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix) && (!next || key > next)).sort();
    const page = keys.slice(0, 1000);
    return {
      items: page.map((key) => ({ key, size: this.objects.get(key)!.size, lastModified: this.objects.get(key)!.lastModified })),
      next: keys.length > 1000 ? (page[page.length - 1] ?? null) : null,
    };
  }

  async listPrefixes(prefix: string): Promise<Page<string>> {
    this.maybeFail("listPrefixes");
    const prefixes = new Set<string>();
    for (const key of this.objects.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash >= 0) prefixes.add(prefix + rest.slice(0, slash + 1));
    }
    return { items: [...prefixes].sort(), next: null };
  }

  async listMultipartUploads(prefix: string): Promise<Page<{ key: string; uploadId: string }>> {
    this.maybeFail("listMultipartUploads");
    const items = [...this.multipart.entries()]
      .filter(([, upload]) => upload.key.startsWith(prefix))
      .map(([uploadId, upload]) => ({ key: upload.key, uploadId }));
    return { items, next: null };
  }

  /** Everything this store holds under a prefix (objects and unfinished uploads), for assertions. */
  under(prefix: string): { objects: string[]; uploads: string[] } {
    return {
      objects: [...this.objects.keys()].filter((key) => key.startsWith(prefix)),
      uploads: [...this.multipart.values()].filter((upload) => upload.key.startsWith(prefix)).map((upload) => upload.key),
    };
  }
}
