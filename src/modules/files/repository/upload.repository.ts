import { Prisma, UploadSession, UploadState } from "@prisma/client";
import { prisma } from "../../../prisma/client";
import { utc } from "../../../prisma/sql";
import { OutboxJobInput } from "../../outbox/outbox.jobs";
import { OutboxTx } from "../../outbox/repository/outbox.repository";

// All UploadSession database access. A session leaves PENDING exactly once, through a conditional
// update, so a completion and a cancellation (or the sweeper) racing each other can't both win.

export type EndedState = "ABORTED" | "EXPIRED" | "FAILED";

export type NewUploadSession = Omit<Prisma.UploadSessionUncheckedCreateInput, "userId" | "createdAt" | "state">;

/** Upload sessions inside an open transaction that holds the owner's row lock. */
export class UploadSessionTx {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly userId: string,
    private readonly now: Date
  ) {}

  /** A session with this id, whoever owns it: ids come from the app, so a clash must be noticed. */
  async findById(id: string): Promise<UploadSession | null> {
    return this.tx.uploadSession.findUnique({ where: { id } });
  }

  /** The owner's unfinished uploads: how many, and the bytes they have reserved. */
  async reservation(): Promise<{ count: number; bytes: bigint }> {
    const { _count, _sum } = await this.tx.uploadSession.aggregate({
      where: { userId: this.userId, state: UploadState.PENDING },
      _count: true,
      _sum: { declaredSize: true },
    });
    return { count: _count, bytes: _sum.declaredSize ?? 0n };
  }

  /** Whether an unfinished upload will create a file with this id. */
  async isFileIdReserved(fileId: string): Promise<boolean> {
    const hit = await this.tx.uploadSession.findFirst({
      where: { userId: this.userId, fileId, state: UploadState.PENDING },
      select: { id: true },
    });
    return hit !== null;
  }

  async create(data: NewUploadSession): Promise<UploadSession> {
    return this.tx.uploadSession.create({ data: { ...data, userId: this.userId, createdAt: this.now } });
  }

  /** PENDING → COMPLETED. False if it had already completed or ended. */
  async markCompleted(id: string): Promise<boolean> {
    const { count } = await this.tx.uploadSession.updateMany({
      where: { id, userId: this.userId, state: UploadState.PENDING },
      data: { state: UploadState.COMPLETED, endedAt: this.now },
    });
    return count === 1;
  }

  async setResultNode(id: string, resultNodeId: string): Promise<void> {
    await this.tx.uploadSession.update({ where: { id }, data: { resultNodeId } });
  }
}

export class UploadRepository {
  async findOwned(userId: string, id: string): Promise<UploadSession | null> {
    return prisma.uploadSession.findFirst({ where: { id, userId } });
  }

  /** Slide a pending upload's expiry forward. Null if it's no longer pending. */
  async touch(id: string, expiresAt: Date): Promise<UploadSession | null> {
    const { count } = await prisma.uploadSession.updateMany({
      where: { id, state: UploadState.PENDING },
      data: { expiresAt },
    });
    return count === 1 ? prisma.uploadSession.findUnique({ where: { id } }) : null;
  }

  /** Record R2's multipart upload id. False if the session already has one or isn't pending. */
  async setR2UploadId(id: string, r2UploadId: string): Promise<boolean> {
    const { count } = await prisma.uploadSession.updateMany({
      where: { id, state: UploadState.PENDING, r2UploadId: null },
      data: { r2UploadId },
    });
    return count === 1;
  }

  /**
   * PENDING → `state`, queueing the cleanup `cleanupFor` builds from the session in the same
   * transaction. False if it wasn't pending (it completed or ended first).
   */
  async end(id: string, state: EndedState, at: Date, cleanupFor: (session: UploadSession) => OutboxJobInput[]): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.uploadSession.updateMany({
        where: { id, state: UploadState.PENDING },
        data: { state, endedAt: at },
      });
      if (count !== 1) return false;
      const session = await tx.uploadSession.findUniqueOrThrow({ where: { id } });
      await new OutboxTx(tx).enqueue(cleanupFor(session));
      return true;
    });
  }

  /**
   * Expire up to `take` pending uploads whose time is up, queueing each one's cleanup in the same
   * transaction. Returns how many expired.
   */
  async expireDue(now: Date, take: number, cleanupFor: (session: UploadSession) => OutboxJobInput[]): Promise<number> {
    return prisma.$transaction(async (tx) => {
      const expired = await tx.$queryRaw<UploadSession[]>`
        UPDATE "UploadSession" SET "state" = 'EXPIRED', "endedAt" = ${utc(now)}
        WHERE "id" IN (
          SELECT "id" FROM "UploadSession"
          WHERE "state" = 'PENDING' AND "expiresAt" < ${utc(now)}
          ORDER BY "expiresAt" LIMIT ${take}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *`;
      await new OutboxTx(tx).enqueue(expired.flatMap(cleanupFor));
      return expired.length;
    });
  }

  /** Every session an account has (reconciliation compares them with the bucket). */
  async allForOwner(userId: string): Promise<Pick<UploadSession, "id" | "objectKey" | "state" | "r2UploadId" | "thumbSize">[]> {
    return prisma.uploadSession.findMany({
      where: { userId },
      select: { id: true, objectKey: true, state: true, r2UploadId: true, thumbSize: true },
    });
  }
}

export const uploadRepository = new UploadRepository();
