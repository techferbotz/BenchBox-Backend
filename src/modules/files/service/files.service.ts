import { Blob, Node, NodeKind } from "@prisma/client";
import { NotFoundError } from "../../../common/errors/AppError";
import { ObjectStore } from "../../../storage/objectStore";
import { objectStore } from "../../../storage/r2Storage";
import { treeRepository } from "../../nodes/repository/tree.repository";
import { DOWNLOAD_URL_TTL_SECONDS, THUMBNAIL_URL_TTL_SECONDS } from "../files.policy";
import { attachmentDisposition, DEFAULT_MIME_TYPE } from "../files.rules";
import { blobRepository } from "../repository/blob.repository";
import { requireStore } from "./storage";

// Downloads and thumbnails (docs/BACKEND_PLAN.md §5.2): short-lived presigned GETs straight from
// R2. Nothing streams through this server, and R2 serves Range requests, so a download can resume
// and a video can seek.

export interface FilesServiceDeps {
  now: () => Date;
  store: ObjectStore | null;
}

export interface DownloadDto {
  url: string;
  expiresAt: string;
}

const fileNotFound = (): NotFoundError => new NotFoundError("File not found");

export class FilesService {
  constructor(private readonly deps: FilesServiceDeps) {}

  /**
   * A URL for the file's bytes, valid DOWNLOAD_URL_TTL_SECONDS, answering with the file's real
   * name and type (object keys carry neither). Files in the trash can be downloaded too: they are
   * still stored, and still billed, until purged.
   */
  async download(userId: string, nodeId: string): Promise<DownloadDto> {
    const store = requireStore(this.deps.store);
    const { node, blob } = await this.liveContent(userId, nodeId);
    const now = this.deps.now();
    const url = await store.presignGet(blob.objectKey, DOWNLOAD_URL_TTL_SECONDS, {
      contentType: node.mimeType ?? DEFAULT_MIME_TYPE,
      contentDisposition: attachmentDisposition(node.name),
    });
    return { url, expiresAt: new Date(now.getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString() };
  }

  /** Where the file's thumbnail is, valid THUMBNAIL_URL_TTL_SECONDS. 404 when it has none. */
  async thumbnailUrl(userId: string, nodeId: string): Promise<string> {
    const store = requireStore(this.deps.store);
    const { blob } = await this.liveContent(userId, nodeId);
    if (!blob.thumbKey) throw new NotFoundError("This file has no thumbnail");
    return store.presignGet(blob.thumbKey, THUMBNAIL_URL_TTL_SECONDS, { contentType: "image/webp" });
  }

  /** The caller's file and its current content. Someone else's, a folder, or purged: not found. */
  private async liveContent(userId: string, nodeId: string): Promise<{ node: Node; blob: Blob }> {
    const node = await treeRepository.findOwned(userId, nodeId);
    if (!node || node.deletedAt || node.kind !== NodeKind.FILE || !node.blobId) throw fileNotFound();
    const blob = await blobRepository.findLive(userId, node.blobId);
    if (!blob) throw fileNotFound();
    return { node, blob };
  }
}

export const filesService = new FilesService({ now: () => new Date(), store: objectStore });
