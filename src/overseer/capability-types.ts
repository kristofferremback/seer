import type { ShareRow } from "../shares";
import type { StageCaptureInventory } from "../stage/db";
import type { ReviewAccountRow, ReviewLineageRow, ReviewRevisionRow } from "./revision-db";
import type { ReviewStackRow, StackAccountRow, StackManifestRow } from "./stack-db";
import type { StackMemberSnapshot } from "./stack-types";

export type CapabilityDocumentKind =
  | "review_revision"
  | "review_account"
  | "stack_manifest"
  | "stack_account";

export interface CapabilityScopeRow {
  share_id: string;
  workspace_id: string;
  document_kind: CapabilityDocumentKind;
  document_id: string;
  created_at: number;
  conversation_scope: "none" | "snapshot";
}

export interface CapabilityFileRow {
  share_id: string;
  workspace_id: string;
  member_position: number;
  revision_id: string;
  capture_id: string;
  file_id: string;
  ordinal: number;
}

export interface CapabilityItemRow {
  share_id: string;
  workspace_id: string;
  member_position: number;
  revision_id: string;
  item_kind: "change" | "material" | "file";
  item_id: string;
  ordinal: number;
}

export interface CapabilityAttachmentRow {
  share_id: string;
  workspace_id: string;
  attachment_id: string;
  review_slug: string;
  ordinal: number;
}

export interface CapabilityMember {
  position: number;
  snapshot: StackMemberSnapshot | null;
  lineage: ReviewLineageRow;
  revision: ReviewRevisionRow;
  account: ReviewAccountRow | null;
  inventory: StageCaptureInventory;
}

export interface ReviewCapability {
  kind: "review";
  share: ShareRow;
  scope: CapabilityScopeRow;
  lineage: ReviewLineageRow;
  revision: ReviewRevisionRow;
  account: ReviewAccountRow | null;
  inventory: StageCaptureInventory;
  files: CapabilityFileRow[];
  items: CapabilityItemRow[];
  attachments: CapabilityAttachmentRow[];
}

export interface StackCapability {
  kind: "stack";
  share: ShareRow;
  scope: CapabilityScopeRow;
  stack: ReviewStackRow;
  manifest: StackManifestRow;
  account: StackAccountRow | null;
  members: CapabilityMember[];
  files: CapabilityFileRow[];
  items: CapabilityItemRow[];
  attachments: CapabilityAttachmentRow[];
}

export type ResolvedCapability = ReviewCapability | StackCapability;

export interface CapabilityDocumentProjection {
  kind: CapabilityDocumentKind;
  slug: string;
  pin: string;
  title: string;
}
