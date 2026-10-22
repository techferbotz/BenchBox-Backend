import { UploadSession } from "@prisma/client";
import { NodeDto } from "../../nodes/dto/node.dto";

// What the app sees of an upload. Presigned URLs are bearer credentials for one object: the app
// uses them straight away and never logs or stores them.

export type OnUploadConflict = "fail" | "rename" | "replace";

/** One request the app makes to R2 itself. Send the body with a Content-Length header (not chunked). */
export interface PresignedRequestDto {
  url: string;
  method: "PUT";
  // Headers to send exactly as given. Empty today; part of the shape so signing can grow.
  headers: Record<string, string>;
  expiresAt: string;
}

export interface UploadDto {
  id: string;
  fileId: string;
  parentId: string | null;
  name: string;
  size: number;
  mimeType: string;
  onConflict: OnUploadConflict;
  state: "pending" | "completed" | "aborted" | "expired" | "failed";
  // "single": PUT the whole file to `put`. "multipart": ask for part URLs.
  mode: "single" | "multipart";
  partSize: number | null;
  partCount: number | null;
  expiresAt: string;
  // Pending single uploads: where to PUT the file.
  put: PresignedRequestDto | null;
  // Pending uploads that declared a thumbnail: where to PUT it (before completing).
  thumbnailPut: PresignedRequestDto | null;
  // GET of a pending multipart upload: the parts R2 already holds at the right size.
  uploadedParts: number[] | null;
  // Completed: the file it made (or replaced).
  node: NodeDto | null;
}

export interface PartUrlDto extends PresignedRequestDto {
  partNumber: number;
  size: number;
}

export interface PartUrlsDto {
  parts: PartUrlDto[];
}

export const uploadStateName = (state: UploadSession["state"]): UploadDto["state"] =>
  state.toLowerCase() as UploadDto["state"];
