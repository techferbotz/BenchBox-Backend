import { Prisma, User } from "@prisma/client";
import { prisma } from "../../../prisma/client";
import { lockUserRow } from "../../../prisma/sql";
import { BlobTx } from "../../files/repository/blob.repository";
import { MeteringTx } from "../../metering/repository/metering.repository";
import { OutboxJobInput } from "../../outbox/outbox.jobs";
import { OutboxTx } from "../../outbox/repository/outbox.repository";

// All User database access. No Prisma outside repositories (HOA protocol 04).

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string | null;
  photoUrl: string | null;
}

export class UserRepository {
  async findActiveById(id: string): Promise<User | null> {
    return prisma.user.findFirst({ where: { id, deletedAt: null } });
  }

  /** Whether an account exists, and whether it was deleted. */
  async findStatus(id: string): Promise<{ deletedAt: Date | null } | null> {
    return prisma.user.findUnique({ where: { id }, select: { deletedAt: true } });
  }

  /**
   * Sign-in: create the account on first sign-in, otherwise refresh its profile from Google (there
   * is no in-app profile editing to preserve). Matching is by Google `sub` only — never by email,
   * which a user can change. A deleted account's `sub` was cleared, so it never matches here and
   * signing in again creates a fresh account.
   *
   * Two first sign-ins racing each other: the loser hits the unique index (P2002) and updates the
   * row the winner created.
   */
  async upsertFromGoogle(profile: GoogleProfile): Promise<{ user: User; isNew: boolean }> {
    const data = { email: profile.email, name: profile.name, photoUrl: profile.photoUrl };
    const existing = await prisma.user.findUnique({ where: { googleSub: profile.sub } });
    if (existing) {
      return { user: await prisma.user.update({ where: { id: existing.id }, data }), isNew: false };
    }
    try {
      const user = await prisma.user.create({ data: { googleSub: profile.sub, ...data } });
      return { user, isNew: true };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const winner = await prisma.user.findUniqueOrThrow({ where: { googleSub: profile.sub } });
        return { user: await prisma.user.update({ where: { id: winner.id }, data }), isNew: false };
      }
      throw err;
    }
  }

  /**
   * Account deletion, in ONE transaction, under the user's row lock:
   *   - every stored file stops being billed (its blobs are marked purged, recorded through the
   *     metering choke point) and `cleanupJobs` — the sweep of the account's objects — is queued;
   *   - every device is signed out;
   *   - the tree and the upload sessions are deleted (file and folder names are personal data; no
   *     device needs tombstones once the account is gone);
   *   - the auto-pay settings (the monthly limit) and the notifications go: nothing will be sent
   *     to the account again;
   *   - the user is anonymised. The row stays as an anonymous anchor for records the law makes us
   *     keep: the storage log, the closed days and statements (and payments, from P5). The days
   *     still open are closed, and billed, as usual.
   * Returns the bytes released.
   */
  async anonymiseAndSignOut(userId: string, now: Date, cleanupJobs: readonly OutboxJobInput[]): Promise<bigint> {
    return prisma.$transaction(
      async (tx) => {
        await lockUserRow(tx, userId);
        const freed = await new BlobTx(tx, userId, now).purgeAll();
        await new MeteringTx(tx, userId, now).recordStorageChange(-freed, "ACCOUNT_DELETE", null);
        await new OutboxTx(tx).enqueue(cleanupJobs);
        await tx.session.deleteMany({ where: { userId } });
        await tx.uploadSession.deleteMany({ where: { userId } });
        await tx.node.deleteMany({ where: { userId } });
        await tx.billingAccount.deleteMany({ where: { userId } });
        await tx.notification.deleteMany({ where: { userId } });
        await tx.user.update({
          where: { id: userId },
          data: { googleSub: null, email: null, name: null, photoUrl: null, deletedAt: now },
        });
        return freed;
      },
      { maxWait: 10_000, timeout: 60_000 }
    );
  }
}

export const userRepository = new UserRepository();
