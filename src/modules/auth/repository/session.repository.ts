import { prisma } from "../../../prisma/client";
import { RefreshCandidate } from "../auth.rules";

// All Session database access. No Prisma outside repositories (HOA protocol 04). Callers hash
// tokens first — a raw refresh token never reaches this layer.

export interface NewSession {
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  deviceId: string | null;
  deviceName: string | null;
  platform: string | null;
  appVersion: string | null;
}

export interface SessionListRow {
  id: string;
  deviceName: string | null;
  platform: string | null;
  appVersion: string | null;
  createdAt: Date;
  lastUsedAt: Date;
}

const candidateSelect = { id: true, userId: true, expiresAt: true, rotatedAt: true } as const;

export class SessionRepository {
  /**
   * Sign-in. A new sign-in on the same install (same deviceId) replaces that install's old
   * session in the same transaction, so reinstalls and re-sign-ins don't pile up "devices".
   */
  async createReplacingDevice(data: NewSession, now: Date): Promise<{ id: string }> {
    return prisma.$transaction(async (tx) => {
      if (data.deviceId) {
        await tx.session.deleteMany({ where: { userId: data.userId, deviceId: data.deviceId } });
      }
      return tx.session.create({
        data: { ...data, createdAt: now, lastUsedAt: now },
        select: { id: true },
      });
    });
  }

  async findByRefreshHash(hash: string): Promise<RefreshCandidate | null> {
    return prisma.session.findUnique({ where: { refreshTokenHash: hash }, select: candidateSelect });
  }

  async findByPreviousHash(hash: string): Promise<RefreshCandidate | null> {
    return prisma.session.findUnique({ where: { previousTokenHash: hash }, select: candidateSelect });
  }

  /**
   * Normal rotation. Conditional on the presented token STILL being current: if a concurrent
   * refresh of the same token got there first, nothing matches, this returns false, and the caller
   * re-reads (and finds the token on the retry path).
   */
  async rotate(
    sessionId: string,
    presentedHash: string,
    nextHash: string,
    expiresAt: Date,
    now: Date
  ): Promise<boolean> {
    const result = await prisma.session.updateMany({
      where: { id: sessionId, refreshTokenHash: presentedHash },
      data: {
        refreshTokenHash: nextHash,
        previousTokenHash: presentedHash,
        rotatedAt: now,
        expiresAt,
        lastUsedAt: now,
      },
    });
    return result.count === 1;
  }

  /**
   * Retry inside the grace window: the app never received the token we last issued, so replace
   * it. `previousTokenHash` and `rotatedAt` are left alone, which anchors the grace window to the
   * first rotation — repeated retries can't stretch it.
   */
  async reissue(
    sessionId: string,
    presentedPreviousHash: string,
    nextHash: string,
    expiresAt: Date,
    now: Date
  ): Promise<boolean> {
    const result = await prisma.session.updateMany({
      where: { id: sessionId, previousTokenHash: presentedPreviousHash },
      data: { refreshTokenHash: nextHash, expiresAt, lastUsedAt: now },
    });
    return result.count === 1;
  }

  async deleteById(sessionId: string): Promise<void> {
    await prisma.session.deleteMany({ where: { id: sessionId } });
  }

  /** Logout. Matches the current token or the one it replaced (a logout racing a refresh). */
  async deleteByTokenHash(hash: string): Promise<void> {
    await prisma.session.deleteMany({
      where: { OR: [{ refreshTokenHash: hash }, { previousTokenHash: hash }] },
    });
  }

  /** What every authenticated request checks: does the session exist, and is its user active? */
  async findForAuth(sessionId: string) {
    return prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        lastUsedAt: true,
        user: { select: { deletedAt: true } },
      },
    });
  }

  /** Job: sessions that idled out are dead weight (refresh would reject them anyway). */
  async deleteExpired(now: Date): Promise<number> {
    const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lte: now } } });
    return count;
  }

  async touch(sessionId: string, now: Date): Promise<void> {
    await prisma.session.updateMany({ where: { id: sessionId }, data: { lastUsedAt: now } });
  }

  async listActiveForUser(userId: string, now: Date): Promise<SessionListRow[]> {
    return prisma.session.findMany({
      where: { userId, expiresAt: { gt: now } },
      orderBy: { lastUsedAt: "desc" },
      select: {
        id: true,
        deviceName: true,
        platform: true,
        appVersion: true,
        createdAt: true,
        lastUsedAt: true,
      },
    });
  }

  /** Revoke one of the user's sessions. False when it isn't theirs (or doesn't exist). */
  async deleteForUser(userId: string, sessionId: string): Promise<boolean> {
    const result = await prisma.session.deleteMany({ where: { id: sessionId, userId } });
    return result.count === 1;
  }

  async deleteOthersForUser(userId: string, keepSessionId: string): Promise<number> {
    const result = await prisma.session.deleteMany({
      where: { userId, NOT: { id: keepSessionId } },
    });
    return result.count;
  }

  /**
   * A push token identifies one app install, so it belongs to one session: registering it here
   * clears it from any other session (another account previously signed in on the same phone).
   */
  async setPushToken(sessionId: string, token: string | null): Promise<void> {
    await prisma.$transaction(async (tx) => {
      if (token !== null) {
        await tx.session.updateMany({
          where: { pushToken: token, NOT: { id: sessionId } },
          data: { pushToken: null },
        });
      }
      await tx.session.update({ where: { id: sessionId }, data: { pushToken: token } });
    });
  }

  /** The push tokens of the user's signed-in devices: where a notification goes. */
  async pushTokensFor(userId: string, now: Date): Promise<string[]> {
    const rows = await prisma.session.findMany({
      where: { userId, expiresAt: { gt: now }, pushToken: { not: null } },
      select: { pushToken: true },
    });
    return rows.flatMap((row) => (row.pushToken ? [row.pushToken] : []));
  }

  /** Forget tokens the push service says are dead (the app was uninstalled, or the token rotated). */
  async clearPushTokens(tokens: readonly string[]): Promise<void> {
    if (tokens.length > 0) await prisma.session.updateMany({ where: { pushToken: { in: [...tokens] } }, data: { pushToken: null } });
  }
}

export const sessionRepository = new SessionRepository();
