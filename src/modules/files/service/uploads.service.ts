import { Node, NodeKind, UploadSession, UploadState } from "@prisma/client";
import {
  BadRequestError,
  ConflictError,
  GoneError,
  NotFoundError,
  PayloadTooLargeError,
  PaymentRequiredError,
} from "../../../common/errors/AppError";
import { ObjectStore } from "../../../storage/objectStore";
import { objectStore } from "../../../storage/r2Storage";
import { meteringService } from "../../metering/service/metering.service";
import { NodeDto, toNodeDto } from "../../nodes/dto/node.dto";
import { availableName, nameKeyOf, normalizeName, numberingPrefixKey } from "../../nodes/nodes.rules";
import { treeRepository } from "../../nodes/repository/tree.repository";
import { isGone, nameConflict, requireLiveFolder } from "../../nodes/service/tree.service";
import { OutboxJobInput, uploadCleanupJob } from "../../outbox/outbox.jobs";
import { OnUploadConflict, PartUrlsDto, PresignedRequestDto, UploadDto, uploadStateName } from "../dto/upload.dto";
import { MAX_PENDING_UPLOADS, MAX_THUMBNAIL_BYTES, STORAGE_MAX_OBJECT_BYTES } from "../files.policy";
import {
  checkParts,
  fitsAllowance,
  normalizeMimeType,
  objectKeyFor,
  parsePartNumbers,
  partSizeOf,
  planUpload,
  thumbKeyFor,
  uploadExpiry,
  uploadUrlTtlSeconds,
} from "../files.rules";
import { uploadRepository } from "../repository/upload.repository";
import { requireStore, storageCall } from "./storage";

// Uploads, straight from the app to R2 (docs/BACKEND_PLAN.md §5.1, deviation D2). This server only
// issues presigned URLs and keeps the books: the object key is reserved before any URL exists, the
// size that gets billed is the one R2 reports, and a file appears in the tree in the same
// transaction that starts billing for it.

// Injected so check:storage-db can run everything against an in-memory store and a moving clock.
export interface UploadsServiceDeps {
  now: () => Date;
  store: ObjectStore | null;
}

export interface StartUploadInput {
  /** The upload's id (the app's). */
  id: string;
  /** The new file's id (the app's). */
  fileId: string;
  parentId: string | null;
  name: unknown;
  size: number;
  mimeType: unknown;
  onConflict: OnUploadConflict;
  /** Bytes of the WebP thumbnail the app will PUT, or null for none. */
  thumbnailSize: number | null;
}

const notFound = (): NotFoundError => new NotFoundError("Upload not found");
const uploadEnded = (): GoneError =>
  new GoneError("This upload was cancelled, expired or failed. Start a new one.", "UPLOAD_ENDED");
const uploadCompleted = (): ConflictError => new ConflictError("This upload has already finished", "UPLOAD_COMPLETED");
const incomplete = (message: string): ConflictError => new ConflictError(message, "UPLOAD_INCOMPLETE");
const idConflict = (what: "upload" | "file"): ConflictError =>
  new ConflictError(`This ${what} id is already used by something else. Generate a new one.`, "ID_CONFLICT");

/** Throws unless the session still accepts bytes. */
const requirePending = (session: UploadSession): void => {
  if (session.state === UploadState.COMPLETED) throw uploadCompleted();
  if (session.state !== UploadState.PENDING) throw uploadEnded();
};

const thumbKeyOf = (session: UploadSession): string => thumbKeyFor(session.userId, session.id);

const cleanupFor =
  (now: Date, delayed: boolean) =>
  (session: UploadSession): OutboxJobInput[] => [
    uploadCleanupJob({ objectKey: session.objectKey, thumbKey: thumbKeyOf(session), r2UploadId: session.r2UploadId }, now, delayed),
  ];

export class UploadsService {
  constructor(private readonly deps: UploadsServiceDeps) {}

  /**
   * Start an upload, or return the one already started with this id (a retry after a lost response
   * is always safe). Refuses — before any bytes move — what can't succeed: a name clash under
   * "fail", a file over the size limit, an account over its storage allowance.
   */
  async start(userId: string, input: StartUploadInput, maxFileSizeBytes: number): Promise<{ upload: UploadDto; created: boolean }> {
    const store = requireStore(this.deps.store);
    const { name, nameKey } = normalizeName(input.name);
    const mimeType = normalizeMimeType(input.mimeType);
    const maxSize = Math.min(maxFileSizeBytes, STORAGE_MAX_OBJECT_BYTES);
    if (input.size > maxSize) {
      throw new PayloadTooLargeError(`A file can be at most ${maxSize} bytes`, "FILE_TOO_LARGE");
    }
    if (input.thumbnailSize !== null && (input.thumbnailSize < 1 || input.thumbnailSize > MAX_THUMBNAIL_BYTES)) {
      throw new BadRequestError(`"thumbnail.size" must be from 1 to ${MAX_THUMBNAIL_BYTES} bytes`);
    }
    const now = this.deps.now();
    const allowance = await meteringService.storageAllowance(userId, now);
    const plan = planUpload(input.size);
    const size = BigInt(input.size);

    // Under the user's lock: the allowance check and the reservation it grants can't interleave
    // with another start, a completion or a purge.
    const started = await treeRepository.inUserLock(userId, now, async (user, account) => {
      if (!account || account.deletedAt) throw new NotFoundError("Account not found");
      const existing = await user.uploads.findById(input.id);
      if (existing) {
        if (existing.userId !== userId || existing.fileId !== input.fileId || existing.declaredSize !== size) {
          throw idConflict("upload");
        }
        return { session: existing, created: false };
      }
      if ((await user.findById(input.fileId)) || (await user.uploads.isFileIdReserved(input.fileId))) {
        throw idConflict("file");
      }
      await requireLiveFolder(user, input.parentId);

      // Checked again at completion, where a clash can no longer fail the upload unless the app
      // asked for "fail" — then it can complete again choosing "rename" or "replace".
      const clash = await user.findActiveSibling(input.parentId, nameKey);
      if (clash && input.onConflict === "fail") throw nameConflict();
      const replacedBytes = clash && input.onConflict === "replace" && clash.kind === NodeKind.FILE ? clash.size : 0n;

      const reservation = await user.uploads.reservation();
      if (reservation.count >= MAX_PENDING_UPLOADS) {
        throw new ConflictError(
          `At most ${MAX_PENDING_UPLOADS} uploads can be in progress at once. Finish or cancel some first.`,
          "TOO_MANY_UPLOADS"
        );
      }
      if (!fitsAllowance({ storedBytes: account.storedBytes, reservedBytes: reservation.bytes, size, replacedBytes, allowance })) {
        throw new PaymentRequiredError("This upload would take the account past its storage limit", "STORAGE_LIMIT_REACHED");
      }

      const session = await user.uploads.create({
        id: input.id,
        fileId: input.fileId,
        parentId: input.parentId,
        name,
        mimeType,
        declaredSize: size,
        onConflict: input.onConflict,
        objectKey: objectKeyFor(userId, input.id),
        thumbSize: input.thumbnailSize,
        partSize: plan.partSize,
        partCount: plan.partCount,
        expiresAt: uploadExpiry(now, now),
      });
      return { session, created: true };
    });

    let session = started.session;
    if (session.state === UploadState.PENDING) {
      if (!started.created) session = await this.touchPending(session, now);
      // Multipart: open it in R2 now, so the first part URLs come back quickly. If R2 fails here,
      // starting again with the same id picks up where this left off.
      if (session.partCount !== null) session = await this.ensureMultipart(store, session);
    }
    return { upload: await this.describe(store, session, now), created: started.created };
  }

  /**
   * The upload as it stands — how an app resumes after a network drop or being killed. For a
   * multipart upload, `uploadedParts` lists the parts R2 already holds; send only the others.
   */
  async get(userId: string, id: string): Promise<UploadDto> {
    const store = requireStore(this.deps.store);
    const found = await uploadRepository.findOwned(userId, id);
    if (!found) throw notFound();
    const now = this.deps.now();
    if (found.state !== UploadState.PENDING) return this.describe(store, found, now);

    let session = await this.touchPending(found, now);
    const { partCount, partSize } = session;
    if (partCount === null || partSize === null) return this.describe(store, session, now);
    session = await this.ensureMultipart(store, session);
    if (session.state !== UploadState.PENDING || !session.r2UploadId) return this.describe(store, session, now);

    const parts = await storageCall(store.listParts(session.objectKey, session.r2UploadId));
    if (parts === null) {
      // R2 no longer has the multipart upload. If the object exists, an earlier complete assembled
      // it and failed before recording the file: completing again finishes the job. If not, R2
      // dropped the upload, and it can't be finished.
      if (await storageCall(store.headObject(session.objectKey))) {
        const all = Array.from({ length: partCount }, (_, i) => i + 1);
        return this.describe(store, session, now, all);
      }
      await uploadRepository.end(session.id, "EXPIRED", now, cleanupFor(now, false));
      return this.describe(store, (await uploadRepository.findOwned(userId, id)) ?? session, now);
    }
    const { done } = checkParts(parts, { partSize, partCount, totalSize: Number(session.declaredSize) });
    return this.describe(store, session, now, done);
  }

  /** Presigned URLs for some of a multipart upload's parts (each signed for its exact size). */
  async partUrls(userId: string, id: string, partNumbersRaw: unknown): Promise<PartUrlsDto> {
    const store = requireStore(this.deps.store);
    const found = await uploadRepository.findOwned(userId, id);
    if (!found) throw notFound();
    requirePending(found);
    if (found.partCount === null || found.partSize === null) {
      throw new BadRequestError("This upload goes up in one PUT; it has no parts", "NOT_MULTIPART");
    }
    const partNumbers = parsePartNumbers(partNumbersRaw, found.partCount);
    const now = this.deps.now();
    const session = await this.ensureMultipart(store, await this.touchPending(found, now));
    requirePending(session);
    const { partSize, partCount, r2UploadId } = session;
    if (partSize === null || partCount === null || r2UploadId === null) throw uploadEnded();

    const ttl = uploadUrlTtlSeconds(session.expiresAt, now);
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => {
        const size = partSizeOf(partNumber, partSize, partCount, Number(session.declaredSize));
        const url = await store.presignUploadPart(session.objectKey, r2UploadId, partNumber, size, ttl);
        return { partNumber, size, url, method: "PUT" as const, headers: {}, expiresAt };
      })
    );
    return { parts };
  }

  /**
   * Finish an upload: R2 assembles the parts, the object's real size is checked against the
   * declared one, and — in one transaction — the file appears (or replaces the one with its name),
   * its bytes start being billed, and the upload is marked done. Safe to call again: a completed
   * upload answers with its file. `onConflictOverride` resolves a name clash that appeared after
   * the start, without uploading again.
   */
  async complete(userId: string, id: string, onConflictOverride: OnUploadConflict | undefined): Promise<UploadDto> {
    const store = requireStore(this.deps.store);
    const session = await uploadRepository.findOwned(userId, id);
    if (!session) throw notFound();
    if (session.state === UploadState.COMPLETED) return this.describe(store, session, this.deps.now());
    if (session.state !== UploadState.PENDING) throw uploadEnded();
    const declared = Number(session.declaredSize);

    // 1. Multipart: have R2 assemble the parts.
    let r2ForgotUpload = false;
    if (session.partCount !== null && session.partSize !== null) {
      if (!session.r2UploadId) throw incomplete("No parts have been uploaded yet");
      const parts = await storageCall(store.listParts(session.objectKey, session.r2UploadId));
      if (parts === null) {
        // Assembled by an earlier call that then failed (the object exists), or dropped by R2.
        r2ForgotUpload = true;
      } else {
        const check = checkParts(parts, { partSize: session.partSize, partCount: session.partCount, totalSize: declared });
        if (!check.complete) {
          throw incomplete(`${check.missing.length} of ${session.partCount} parts are missing or the wrong size`);
        }
        await storageCall(store.completeMultipartUpload(session.objectKey, session.r2UploadId, check.complete));
      }
    }

    // 2. What actually landed. Billing never uses the size the client declared.
    const head = await storageCall(store.headObject(session.objectKey));
    const now = this.deps.now();
    if (!head) {
      if (r2ForgotUpload) {
        await uploadRepository.end(session.id, "EXPIRED", now, cleanupFor(now, false));
        throw uploadEnded();
      }
      throw incomplete("Upload the file before completing");
    }
    if (head.size !== declared) {
      await uploadRepository.end(session.id, "FAILED", now, cleanupFor(now, true));
      throw new ConflictError(`The upload holds ${head.size} bytes, not the ${declared} declared. Start a new upload.`, "SIZE_MISMATCH");
    }

    // 3. The thumbnail, if one was declared and uploaded. Its absence never fails the upload.
    let thumbKey: string | null = null;
    if (session.thumbSize !== null) {
      const thumb = await storageCall(store.headObject(thumbKeyOf(session)));
      if (thumb && thumb.size > 0 && thumb.size <= MAX_THUMBNAIL_BYTES) thumbKey = thumbKeyOf(session);
    }

    // 4. One transaction: the file appears, its bytes are billed, the upload is done.
    const policy = onConflictOverride ?? (session.onConflict as OnUploadConflict);
    await treeRepository.inUserTransaction(userId, now, async (tree) => {
      // Claim the completion first. If it's no longer pending, another call completed it (or it
      // was cancelled or expired) — the re-read below answers either way.
      if (!(await tree.uploads.markCompleted(session.id))) return;

      // Its folder, or the root if that folder was deleted or trashed since the start.
      let parentId = session.parentId;
      if (parentId !== null) {
        const parent = await tree.findOwned(parentId);
        if (isGone(parent) || parent.kind !== NodeKind.FOLDER || parent.trashedAt) parentId = null;
      }

      let replacing: Node | null = null;
      let name = session.name;
      const clash = await tree.findActiveSibling(parentId, nameKeyOf(name));
      if (clash) {
        if (policy === "replace" && clash.kind === NodeKind.FILE) {
          replacing = clash;
        } else if (policy === "fail") {
          throw nameConflict(); // rolls back: the upload stays pending, its bytes in place
        } else {
          // "rename" — or "replace" when the clash is a folder, which a file never replaces.
          const taken = await tree.siblingKeysWithPrefix(parentId, numberingPrefixKey(name, "FILE"));
          name = availableName(name, "FILE", taken);
        }
      }
      if (!replacing && (await tree.findById(session.fileId))) throw idConflict("file");

      const size = BigInt(head.size);
      await tree.blobs.create({ id: session.id, bucket: store.bucket, objectKey: session.objectKey, thumbKey, size });
      await tree.metering.recordStorageChange(size, "UPLOAD", session.id);
      const content = { size, mimeType: session.mimeType, blobId: session.id, hasThumbnail: thumbKey !== null };
      let node: Node;
      if (replacing) {
        // No version history in v1: the old content stops being billed now and its object goes.
        node = await tree.replaceContent(replacing.id, content);
        if (replacing.blobId) await tree.releaseContent([replacing.blobId], "REPLACE", replacing.id);
      } else {
        node = await tree.createFile({ id: session.fileId, parentId, name, nameKey: nameKeyOf(name), ...content });
      }
      await tree.uploads.setResultNode(session.id, node.id);
    });

    const final = await uploadRepository.findOwned(userId, id);
    if (!final) throw notFound();
    if (final.state !== UploadState.COMPLETED) throw uploadEnded();
    return this.describe(store, final, now);
  }

  /**
   * Cancel an upload. Idempotent. What it uploaded is deleted once the URLs it was given have
   * expired (they can't be revoked, so a PUT already under way must land first).
   */
  async abort(userId: string, id: string): Promise<void> {
    const session = await uploadRepository.findOwned(userId, id);
    if (!session) throw notFound();
    if (session.state === UploadState.COMPLETED) throw uploadCompleted();
    if (session.state !== UploadState.PENDING) return;
    const now = this.deps.now();
    if (await uploadRepository.end(session.id, "ABORTED", now, cleanupFor(now, true))) return;
    const fresh = await uploadRepository.findOwned(userId, id);
    if (fresh?.state === UploadState.COMPLETED) throw uploadCompleted();
  }

  /** Job: expire uploads idle past their expiry and queue their cleanup. */
  async expireStale(now: Date): Promise<string> {
    const BATCH = 200;
    let expired = 0;
    for (let round = 0; round < 50; round += 1) {
      const count = await uploadRepository.expireDue(now, BATCH, cleanupFor(now, false));
      expired += count;
      if (count < BATCH) break;
    }
    return `expired ${expired} upload(s)`;
  }

  // ---------------------------------------------------------------- helpers

  /** Slide a pending upload's expiry; throws if it stopped being pending meanwhile. */
  private async touchPending(session: UploadSession, now: Date): Promise<UploadSession> {
    const touched = await uploadRepository.touch(session.id, uploadExpiry(session.createdAt, now));
    if (touched) return touched;
    const fresh = await uploadRepository.findOwned(session.userId, session.id);
    if (!fresh) throw notFound();
    requirePending(fresh);
    return fresh;
  }

  /** Make sure R2 has a multipart upload for this session; returns the session as it now stands. */
  private async ensureMultipart(store: ObjectStore, session: UploadSession): Promise<UploadSession> {
    if (session.r2UploadId || session.partCount === null) return session;
    const r2UploadId = await storageCall(store.createMultipartUpload(session.objectKey));
    if (await uploadRepository.setR2UploadId(session.id, r2UploadId)) return { ...session, r2UploadId };
    // Another request opened one first, or the upload ended: keep theirs and drop ours. R2's
    // 7-day rule for unfinished uploads backs this up if the abort fails.
    await store.abortMultipartUpload(session.objectKey, r2UploadId).catch(() => undefined);
    const fresh = await uploadRepository.findOwned(session.userId, session.id);
    if (!fresh) throw notFound();
    return fresh;
  }

  private async describe(store: ObjectStore, session: UploadSession, now: Date, uploadedParts: number[] | null = null): Promise<UploadDto> {
    const pending = session.state === UploadState.PENDING;
    const ttl = uploadUrlTtlSeconds(session.expiresAt, now);
    const put = async (key: string, contentLength: number): Promise<PresignedRequestDto> => ({
      url: await store.presignPut(key, contentLength, ttl),
      method: "PUT",
      headers: {},
      expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    });
    let node: NodeDto | null = null;
    if (session.state === UploadState.COMPLETED && session.resultNodeId) {
      const row = await treeRepository.findOwned(session.userId, session.resultNodeId);
      node = row ? toNodeDto(row) : null;
    }
    return {
      id: session.id,
      fileId: session.fileId,
      parentId: session.parentId,
      name: session.name,
      size: Number(session.declaredSize),
      mimeType: session.mimeType,
      onConflict: session.onConflict as OnUploadConflict,
      state: uploadStateName(session.state),
      mode: session.partCount === null ? "single" : "multipart",
      partSize: session.partSize,
      partCount: session.partCount,
      expiresAt: session.expiresAt.toISOString(),
      put: pending && session.partCount === null ? await put(session.objectKey, Number(session.declaredSize)) : null,
      thumbnailPut: pending && session.thumbSize !== null ? await put(thumbKeyOf(session), session.thumbSize) : null,
      uploadedParts: pending ? uploadedParts : null,
      node,
    };
  }
}

export const uploadsService = new UploadsService({ now: () => new Date(), store: objectStore });
