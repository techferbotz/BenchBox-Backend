import { Node, NodeKind } from "@prisma/client";
import { BadRequestError, ConflictError, NotFoundError } from "../../../common/errors/AppError";
import { NodeDto, PageDto, toNodeDto } from "../dto/node.dto";
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  SEARCH_MAX_QUERY_LENGTH,
  TRASH_RETENTION_DAYS,
} from "../nodes.policy";
import {
  availableName,
  decodeChildrenCursor,
  decodeNameCursor,
  decodeTrashCursor,
  encodeChildrenCursor,
  encodeNameCursor,
  encodeTrashCursor,
  nameKeyOf,
  normalizeName,
  numberingPrefixKey,
  parseLimit,
} from "../nodes.rules";
import { treeRepository, UserTx } from "../repository/tree.repository";

export type OnNameConflict = "fail" | "rename";

// Injected so check:tree-db can drive time (trash expiry) without a test switch in production code.
export interface TreeServiceDeps {
  now: () => Date;
}

export const nameConflict = (): ConflictError =>
  new ConflictError("Something with this name is already in that folder", "NAME_CONFLICT");

// A node that's gone (purged) is not found; one that exists elsewhere in the tree is the caller's
// to manage. Someone else's node is not found too — never forbidden (HOA protocol 04).
export const isGone = (node: Node | null): node is null => node === null || node.deletedAt !== null;

/** The folder that will contain something: must be the caller's, alive, a folder, and not trashed. */
export const requireLiveFolder = async (tree: UserTx, parentId: string | null): Promise<void> => {
  if (parentId === null) return;
  const parent = await tree.findOwned(parentId);
  if (isGone(parent)) throw new NotFoundError("Folder not found");
  if (parent.kind !== NodeKind.FOLDER) throw new ConflictError("That isn't a folder", "NOT_A_FOLDER");
  if (parent.trashedAt) throw new ConflictError("That folder is in the trash", "NODE_TRASHED");
};

export class TreeService {
  constructor(private readonly deps: TreeServiceDeps) {}

  /**
   * Create a folder with the app's id. Idempotent: the same id again returns the folder as it is
   * now (created = false), so a retry after a lost response is always safe.
   */
  async createFolder(
    userId: string,
    input: { id: string; parentId: string | null; name: unknown; onConflict: OnNameConflict }
  ): Promise<{ node: NodeDto; created: boolean }> {
    const { name, nameKey } = normalizeName(input.name);
    return treeRepository.inUserTransaction(userId, this.deps.now(), async (tree) => {
      const existing = await tree.findById(input.id);
      if (existing) {
        if (existing.userId !== userId || existing.kind !== NodeKind.FOLDER) {
          throw new ConflictError("This id is already used by something else. Generate a new one.", "ID_CONFLICT");
        }
        return { node: toNodeDto(existing), created: false };
      }

      await requireLiveFolder(tree, input.parentId);
      let finalName = name;
      if (await tree.isNameTaken(input.parentId, nameKey)) {
        if (input.onConflict === "fail") throw nameConflict();
        const taken = await tree.siblingKeysWithPrefix(input.parentId, numberingPrefixKey(name, "FOLDER"));
        finalName = availableName(name, "FOLDER", taken);
      }
      const node = await tree.createFolder({
        id: input.id,
        parentId: input.parentId,
        name: finalName,
        nameKey: nameKeyOf(finalName),
      });
      return { node: toNodeDto(node), created: true };
    });
  }

  async getNode(userId: string, id: string): Promise<NodeDto> {
    const node = await treeRepository.findOwned(userId, id);
    if (isGone(node)) throw new NotFoundError("Not found");
    return toNodeDto(node);
  }

  /**
   * A folder's children (the root when `folderId` is null): folders first, then files, each by name.
   * A trashed folder lists its trashed children, so the trash can be browsed.
   */
  async listChildren(userId: string, folderId: string | null, cursorRaw: unknown, limitRaw: unknown): Promise<PageDto<NodeDto>> {
    const limit = parseLimit(limitRaw, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
    const cursor = decodeChildrenCursor(cursorRaw);

    let state: "active" | "trashed" = "active";
    if (folderId !== null) {
      const folder = await treeRepository.findOwned(userId, folderId);
      if (isGone(folder) || folder.kind !== NodeKind.FOLDER) throw new NotFoundError("Folder not found");
      if (folder.trashedAt) state = "trashed";
    }

    const items: Node[] = [];
    let phase = cursor?.phase ?? "FOLDER";
    let after = cursor?.after ?? null;

    if (phase === "FOLDER") {
      const folders = await treeRepository.listChildrenOfKind(userId, folderId, NodeKind.FOLDER, state, after, limit + 1);
      if (folders.length > limit) {
        const page = folders.slice(0, limit);
        const last = page[page.length - 1]!;
        return {
          items: page.map(toNodeDto),
          nextCursor: encodeChildrenCursor({ phase: "FOLDER", after: { nameKey: last.nameKey, id: last.id } }),
          hasMore: true,
        };
      }
      items.push(...folders);
      phase = "FILE";
      after = null;
    }

    const room = limit - items.length;
    const files = await treeRepository.listChildrenOfKind(userId, folderId, NodeKind.FILE, state, after, room + 1);
    const pageFiles = files.slice(0, room);
    items.push(...pageFiles);
    const hasMore = files.length > room;
    const lastFile = pageFiles[pageFiles.length - 1];
    const nextCursor = !hasMore
      ? null
      : encodeChildrenCursor({
          phase: "FILE",
          after: lastFile ? { nameKey: lastFile.nameKey, id: lastFile.id } : null,
        });
    return { items: items.map(toNodeDto), nextCursor, hasMore };
  }

  /**
   * Rename and/or move. Changes apply in the order they arrive. `ifSeq` makes it conditional: if the
   * node changed since the caller last saw it (its syncSeq moved on), nothing happens and the answer
   * is 409 NODE_CHANGED — how an app replaying offline edits avoids overwriting a newer change.
   */
  async updateNode(
    userId: string,
    id: string,
    input: { name?: unknown; parentId?: string | null; ifSeq?: number }
  ): Promise<NodeDto> {
    if (input.name === undefined && input.parentId === undefined) {
      throw new BadRequestError('Send "name", "parentId", or both');
    }
    const renamed = input.name === undefined ? null : normalizeName(input.name);

    return treeRepository.inUserTransaction(userId, this.deps.now(), async (tree) => {
      const node = await tree.findOwned(id);
      if (isGone(node)) throw new NotFoundError("Not found");
      if (input.ifSeq !== undefined && BigInt(input.ifSeq) !== node.syncSeq) {
        throw new ConflictError("This item changed since you last saw it", "NODE_CHANGED");
      }
      if (node.trashedAt) throw new ConflictError("Restore it from the trash first", "NODE_TRASHED");

      const parentId = input.parentId === undefined ? node.parentId : input.parentId;
      if (parentId !== node.parentId && parentId !== null) {
        await requireLiveFolder(tree, parentId);
        if (node.kind === NodeKind.FOLDER && (await tree.wouldCreateCycle(node.id, parentId))) {
          throw new ConflictError("A folder can't be moved into itself", "MOVE_INTO_SELF");
        }
      }

      const name = renamed?.name ?? node.name;
      const nameKey = renamed?.nameKey ?? node.nameKey;
      if ((parentId !== node.parentId || nameKey !== node.nameKey) && (await tree.isNameTaken(parentId, nameKey, node.id))) {
        throw nameConflict();
      }
      return toNodeDto(await tree.place(node.id, { parentId, name, nameKey }));
    });
  }

  /** Put a node, and everything inside it, in the trash as one batch. Idempotent. */
  async trash(userId: string, id: string): Promise<NodeDto> {
    return treeRepository.inUserTransaction(userId, this.deps.now(), async (tree) => {
      const node = await tree.findOwned(id);
      if (isGone(node)) throw new NotFoundError("Not found");
      if (node.trashedAt) return toNodeDto(node);
      await tree.trashSubtree(node.id);
      return toNodeDto((await tree.findOwned(node.id))!);
    });
  }

  /**
   * Restore a trashed item (the one the user trashed, not something inside it) with everything that
   * was trashed with it. It goes back to its folder, or to the root if that folder is gone or itself
   * in the trash; a name clash there is resolved by numbering ("Photos (1)"). Idempotent.
   */
  async restore(userId: string, id: string): Promise<NodeDto> {
    return treeRepository.inUserTransaction(userId, this.deps.now(), async (tree) => {
      const node = await tree.findOwned(id);
      if (isGone(node)) throw new NotFoundError("Not found");
      if (!node.trashedAt) return toNodeDto(node);
      if (node.trashRootId !== node.id) {
        throw new ConflictError("Restore the folder this was trashed with", "NOT_TRASH_ROOT");
      }

      let parentId = node.parentId;
      if (parentId !== null) {
        const parent = await tree.findOwned(parentId);
        if (isGone(parent) || parent.trashedAt) parentId = null;
      }
      const kind = node.kind === NodeKind.FOLDER ? "FOLDER" : "FILE";
      let name = node.name;
      if (await tree.isNameTaken(parentId, node.nameKey)) {
        name = availableName(name, kind, await tree.siblingKeysWithPrefix(parentId, numberingPrefixKey(name, kind)));
      }
      return toNodeDto(await tree.restoreBatch(node.id, { parentId, name, nameKey: nameKeyOf(name) }));
    });
  }

  /**
   * Permanently delete a trashed node and everything under it. Only from the trash. Idempotent: a
   * node already purged answers the same. The files' bytes stop being billed in the same
   * transaction, and their objects' deletion is queued (TreeTx.releaseContent).
   */
  async purge(userId: string, id: string): Promise<void> {
    await treeRepository.inUserTransaction(userId, this.deps.now(), async (tree) => {
      const node = await tree.findOwned(id);
      if (node === null) throw new NotFoundError("Not found");
      if (node.deletedAt) return;
      if (!node.trashedAt) throw new ConflictError("Move it to the trash first", "NOT_IN_TRASH");
      await tree.purgeSubtree(node.id);
    });
  }

  async listTrash(userId: string, cursorRaw: unknown, limitRaw: unknown): Promise<PageDto<NodeDto>> {
    const limit = parseLimit(limitRaw, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
    const rows = await treeRepository.listTrashRoots(userId, decodeTrashCursor(cursorRaw) ?? null, limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toNodeDto),
      nextCursor: rows.length > limit && last ? encodeTrashCursor({ trashedAt: last.trashedAt!, id: last.id }) : null,
      hasMore: rows.length > limit,
    };
  }

  async emptyTrash(userId: string): Promise<{ purged: number }> {
    return treeRepository.inUserTransaction(userId, this.deps.now(), async (tree) => ({
      purged: await tree.purgeAllTrashed(),
    }));
  }

  /** Names containing `q` (case-insensitive), outside the trash, by name. */
  async search(userId: string, qRaw: unknown, cursorRaw: unknown, limitRaw: unknown): Promise<PageDto<NodeDto>> {
    if (typeof qRaw !== "string" || qRaw.trim().length === 0) {
      throw new BadRequestError('"q" is required');
    }
    const fragment = nameKeyOf(qRaw.trim());
    if (fragment.length > SEARCH_MAX_QUERY_LENGTH) {
      throw new BadRequestError(`"q" can be at most ${SEARCH_MAX_QUERY_LENGTH} characters`);
    }
    const limit = parseLimit(limitRaw, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
    const rows = await treeRepository.search(userId, fragment, decodeNameCursor(cursorRaw) ?? null, limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toNodeDto),
      nextCursor: rows.length > limit && last ? encodeNameCursor({ nameKey: last.nameKey, id: last.id }) : null,
      hasMore: rows.length > limit,
    };
  }

  /** Job: purge whatever has been in the trash for TRASH_RETENTION_DAYS. Returns a one-line summary. */
  async purgeExpiredTrash(now: Date): Promise<string> {
    const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let users = 0;
    let nodes = 0;
    for (let batch = 0; batch < 1000; batch += 1) {
      const userIds = await treeRepository.usersWithTrashBefore(cutoff, 100);
      if (userIds.length === 0) break;
      for (const userId of userIds) {
        nodes += await treeRepository.inUserTransaction(userId, now, (tree) => tree.purgeTrashedBefore(cutoff));
        users += 1;
      }
    }
    return `purged ${nodes} node(s) for ${users} user(s) trashed before ${cutoff.toISOString()}`;
  }
}

export const treeService = new TreeService({ now: () => new Date() });
