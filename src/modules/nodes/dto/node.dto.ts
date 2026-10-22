import { Node } from "@prisma/client";

// What the app sees of a node. The same shape everywhere — listings, search, the change feed — so
// the app's cache stores one thing.

export interface NodeDto {
  id: string;
  parentId: string | null;
  kind: "folder" | "file";
  // Empty once purged (deletedAt set): a tombstone only says "drop this id".
  name: string;
  size: number;
  mimeType: string | null;
  // Files: changes whenever the content does (a replacing upload) — not on rename or move. The
  // cache key for the thumbnail and for a downloaded copy. Null for folders.
  contentId: string | null;
  // Files: whether GET /api/v1/files/{id}/thumbnail has an image.
  hasThumbnail: boolean;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
  // Set while trashed: the node the user trashed (equal to `id` for the item shown in the trash).
  trashRootId: string | null;
  deletedAt: string | null;
  // The node's version: send it back as `ifSeq` so a replayed edit can't overwrite a newer change.
  syncSeq: number;
}

export const toNodeDto = (node: Node): NodeDto => ({
  id: node.id,
  parentId: node.parentId,
  kind: node.kind === "FOLDER" ? "folder" : "file",
  name: node.name,
  size: Number(node.size),
  mimeType: node.mimeType,
  contentId: node.deletedAt ? null : node.blobId,
  hasThumbnail: node.hasThumbnail,
  createdAt: node.createdAt.toISOString(),
  updatedAt: node.updatedAt.toISOString(),
  trashedAt: node.trashedAt?.toISOString() ?? null,
  trashRootId: node.trashRootId,
  deletedAt: node.deletedAt?.toISOString() ?? null,
  syncSeq: Number(node.syncSeq),
});

export interface PageDto<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ChangesDto {
  changes: NodeDto[];
  // Store it and send it next time. Always set, even when there were no changes.
  nextCursor: string;
  hasMore: boolean;
}
