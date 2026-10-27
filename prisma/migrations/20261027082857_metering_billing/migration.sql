-- CreateEnum
CREATE TYPE "StatementStatus" AS ENUM ('OPEN', 'CARRIED');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('NONE', 'PENDING', 'SENT', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "PriceBook" (
    "id" UUID NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "storagePaisePerGbMonth" BIGINT NOT NULL,
    "freeBytes" BIGINT NOT NULL,
    "gstBasisPoints" INTEGER NOT NULL,
    "minimumChargePaise" BIGINT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageDay" (
    "userId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "byteSeconds" DECIMAL(38,3) NOT NULL,
    "billableByteSeconds" DECIMAL(38,3) NOT NULL,
    "peakBytes" BIGINT NOT NULL,
    "endBytes" BIGINT NOT NULL,
    "lastEventId" BIGINT NOT NULL,
    "chargeMicroPaise" BIGINT NOT NULL,
    "priceBookId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageDay_pkey" PRIMARY KEY ("userId","day")
);

-- CreateTable
CREATE TABLE "Statement" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "byteSeconds" DECIMAL(38,3) NOT NULL,
    "billableByteSeconds" DECIMAL(38,3) NOT NULL,
    "priceBookId" UUID NOT NULL,
    "storagePaisePerGbMonth" BIGINT NOT NULL,
    "gstBasisPoints" INTEGER NOT NULL,
    "minimumChargePaise" BIGINT NOT NULL,
    "subtotalPaise" BIGINT NOT NULL,
    "gstPaise" BIGINT NOT NULL,
    "carriedInPaise" BIGINT NOT NULL,
    "totalPaise" BIGINT NOT NULL,
    "status" "StatementStatus" NOT NULL,
    "carriedIntoId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Statement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAccount" (
    "userId" UUID NOT NULL,
    "monthlyLimitPaise" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAccount_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "push" "DeliveryState" NOT NULL,
    "email" "DeliveryState" NOT NULL,
    "pushDetail" TEXT,
    "emailDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PriceBook_effectiveFrom_key" ON "PriceBook"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Statement_carriedIntoId_key" ON "Statement"("carriedIntoId");

-- CreateIndex
CREATE UNIQUE INDEX "Statement_userId_periodStart_key" ON "Statement"("userId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "UsageDay" ADD CONSTRAINT "UsageDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageDay" ADD CONSTRAINT "UsageDay_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "PriceBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Statement" ADD CONSTRAINT "Statement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Statement" ADD CONSTRAINT "Statement_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "PriceBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAccount" ADD CONSTRAINT "BillingAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One price per month, and numbers that make sense. Prisma can't express CHECK constraints; it
-- leaves them alone.
ALTER TABLE "PriceBook" ADD CONSTRAINT "PriceBook_effectiveFrom_first_of_month" CHECK (EXTRACT(DAY FROM "effectiveFrom") = 1);
ALTER TABLE "PriceBook" ADD CONSTRAINT "PriceBook_numbers" CHECK (
  "storagePaisePerGbMonth" >= 0 AND "freeBytes" >= 0 AND "gstBasisPoints" BETWEEN 0 AND 10000 AND "minimumChargePaise" >= 0
);

-- The suggested defaults (docs/BACKEND_PLAN.md §13): ₹2.50 per GB-month above 2 GB free, 18% GST,
-- a ₹10 minimum charge. NOT yet confirmed by the owner: a confirmed price is a new row
-- (docs/DEPLOY.md, "Changing the price"), never an edit of this one. Effective from October 2026,
-- before the first byte was stored (2026-10-26).
INSERT INTO "PriceBook" ("id", "effectiveFrom", "storagePaisePerGbMonth", "freeBytes", "gstBasisPoints", "minimumChargePaise", "note")
VALUES ('3a7d1e0c-5b6f-4c2a-9e81-0d4b7f2c6a93', DATE '2026-10-01', 250, 2000000000, 1800, 1000,
        'Suggested defaults (docs/BACKEND_PLAN.md §13), not yet confirmed by the owner');
