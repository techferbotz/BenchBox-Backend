import { Prisma } from "@prisma/client";

// Raw-SQL helpers shared by repositories (and imported only by them, like the client itself).

/** A timestamp for raw SQL, pinned to UTC whatever the session time zone is (columns are UTC). */
export const utc = (date: Date): Prisma.Sql => Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/**
 * Take the user's row lock for the rest of the transaction WITHOUT changing the row. It conflicts
 * with the UPDATE that starts every tree transaction, so whatever runs under it is serialised
 * with the user's tree and storage changes. Null when there is no such user.
 */
export const lockUserRow = async (
  tx: Prisma.TransactionClient,
  userId: string
): Promise<{ deletedAt: Date | null; storedBytes: bigint } | null> => {
  const rows = await tx.$queryRaw<{ deletedAt: Date | null; storedBytes: bigint }[]>`
    SELECT "deletedAt", "storedBytes" FROM "User" WHERE "id" = ${userId}::uuid FOR NO KEY UPDATE`;
  return rows[0] ?? null;
};
