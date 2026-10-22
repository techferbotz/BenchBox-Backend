import { NotFoundError } from "../../../common/errors/AppError";
import { FREE_STORAGE_BYTES } from "../../files/files.policy";
import { meteringRepository } from "../repository/metering.repository";

// Live storage numbers. Bills (P4) will be built from the same StorageEvent log.

export interface StorageUsageDto {
  // Billed bytes: every file, trash included, until purged.
  usedBytes: number;
  // The part of usedBytes that is in the trash.
  trashBytes: number;
  // What unfinished uploads have reserved against the limit.
  uploadingBytes: number;
  // The free allowance.
  freeBytes: number;
  // The most the account may store right now; null = no limit (from P5, with auto-pay set up).
  limitBytes: number | null;
}

export class MeteringService {
  /**
   * How many bytes the account may store, or null for no limit. Until billing exists (P4/P5) that
   * is the free allowance; from P5 an active auto-pay mandate or Play credit lifts it.
   */
  async storageAllowance(_userId: string): Promise<bigint | null> {
    return BigInt(FREE_STORAGE_BYTES);
  }

  async usage(userId: string): Promise<StorageUsageDto> {
    const [row, allowance] = await Promise.all([meteringRepository.usage(userId), this.storageAllowance(userId)]);
    if (!row) throw new NotFoundError("Account not found");
    return {
      usedBytes: Number(row.storedBytes),
      trashBytes: Number(row.trashBytes),
      uploadingBytes: Number(row.reservedBytes),
      freeBytes: FREE_STORAGE_BYTES,
      limitBytes: allowance === null ? null : Number(allowance),
    };
  }
}

export const meteringService = new MeteringService();
