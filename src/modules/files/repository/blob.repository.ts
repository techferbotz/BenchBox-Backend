import { Blob, Prisma } from "@prisma/client";
import { prisma } from "../../../prisma/client";
import { utc } from "../../../prisma/sql";

// All Blob database access. A blob is created by a completed upload and marked purged — never
// deleted — when its bytes stop being billed; its object's deletion is queued in the same
// transaction (the outbox), so the row is the record of what was stored and when it went.

export interface PurgedBlob {
  id: string;
  size: bigint;
  objectKey: string;
  thumbKey: string | null;
}

/** Blobs inside an open transaction that holds the owner's row lock. */
export class BlobTx {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly userId: string,
    private readonly now: Date
  ) {}

  async create(data: { id: string; bucket: string; objectKey: string; thumbKey: string | null; size: bigint }): Promise<Blob> {
    return this.tx.blob.create({ data: { ...data, userId: this.userId, createdAt: this.now } });
  }

  /** Mark these blobs purged (those that aren't yet) and return them. */
  async purge(ids: readonly string[]): Promise<PurgedBlob[]> {
    if (ids.length === 0) return [];
    // ONE array parameter, however many files a purge takes: a statement binds at most 65,535
    // parameters, and building a list of 70,000 took Prisma minutes before even failing.
    return this.tx.$queryRaw<PurgedBlob[]>`
      UPDATE "Blob" SET "purgedAt" = ${utc(this.now)}
      WHERE "userId" = ${this.userId}::uuid AND "purgedAt" IS NULL AND "id" = ANY(${[...ids]}::uuid[])
      RETURNING "id", "size", "objectKey", "thumbKey"`;
  }

  /** Account deletion: mark every unpurged blob purged. Returns the bytes they held. */
  async purgeAll(): Promise<bigint> {
    const [row] = await this.tx.$queryRaw<{ bytes: bigint | null }[]>`
      WITH purged AS (
        UPDATE "Blob" SET "purgedAt" = ${utc(this.now)}
        WHERE "userId" = ${this.userId}::uuid AND "purgedAt" IS NULL
        RETURNING "size"
      )
      SELECT SUM("size")::bigint AS "bytes" FROM purged`;
    return row?.bytes ?? 0n;
  }
}

export class BlobRepository {
  /** The unpurged blob a file points at. */
  async findLive(userId: string, id: string): Promise<Blob | null> {
    return prisma.blob.findFirst({ where: { id, userId, purgedAt: null } });
  }

  /** Every blob an account has (reconciliation compares them with the bucket). */
  async allForOwner(userId: string): Promise<Pick<Blob, "id" | "objectKey" | "thumbKey" | "purgedAt">[]> {
    return prisma.blob.findMany({ where: { userId }, select: { id: true, objectKey: true, thumbKey: true, purgedAt: true } });
  }

  /** Accounts holding unpurged blobs, a page at a time (reconciliation). */
  async ownersWithLiveBlobs(afterUserId: string | null, take: number): Promise<string[]> {
    const rows = await prisma.blob.findMany({
      where: { purgedAt: null, ...(afterUserId ? { userId: { gt: afterUserId } } : {}) },
      select: { userId: true },
      distinct: ["userId"],
      orderBy: { userId: "asc" },
      take,
    });
    return rows.map((row) => row.userId);
  }
}

export const blobRepository = new BlobRepository();
