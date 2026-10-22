-- CreateEnum
CREATE TYPE "UploadState" AS ENUM ('PENDING', 'COMPLETED', 'ABORTED', 'EXPIRED', 'FAILED');

-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "blobId" UUID,
ADD COLUMN     "hasThumbnail" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "storedBytes" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Blob" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "thumbKey" TEXT,
    "size" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgedAt" TIMESTAMP(3),

    CONSTRAINT "Blob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "declaredSize" BIGINT NOT NULL,
    "onConflict" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "thumbSize" INTEGER,
    "r2UploadId" TEXT,
    "partSize" INTEGER,
    "partCount" INTEGER,
    "state" "UploadState" NOT NULL DEFAULT 'PENDING',
    "resultNodeId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageEvent" (
    "id" BIGSERIAL NOT NULL,
    "userId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "deltaBytes" BIGINT NOT NULL,
    "totalAfter" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "refId" TEXT,

    CONSTRAINT "StorageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxJob" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Blob_objectKey_key" ON "Blob"("objectKey");

-- CreateIndex
CREATE UNIQUE INDEX "Blob_thumbKey_key" ON "Blob"("thumbKey");

-- CreateIndex
CREATE INDEX "Blob_userId_purgedAt_idx" ON "Blob"("userId", "purgedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UploadSession_objectKey_key" ON "UploadSession"("objectKey");

-- CreateIndex
CREATE INDEX "UploadSession_userId_state_idx" ON "UploadSession"("userId", "state");

-- CreateIndex
CREATE INDEX "UploadSession_state_expiresAt_idx" ON "UploadSession"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "StorageEvent_userId_id_idx" ON "StorageEvent"("userId", "id");

-- CreateIndex
CREATE INDEX "StorageEvent_userId_at_idx" ON "StorageEvent"("userId", "at");

-- CreateIndex
CREATE INDEX "OutboxJob_runAfter_id_idx" ON "OutboxJob"("runAfter", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Node_blobId_key" ON "Node"("blobId");

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_blobId_fkey" FOREIGN KEY ("blobId") REFERENCES "Blob"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Blob" ADD CONSTRAINT "Blob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageEvent" ADD CONSTRAINT "StorageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateIndex
CREATE INDEX "Node_parentId_idx" ON "Node"("parentId");

