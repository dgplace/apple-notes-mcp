export interface EntityIdentity {
  id: string;
  name: string;
}

export interface NoteLocation {
  account: EntityIdentity;
  folder: EntityIdentity;
}

export type RichContentKind = "attachment" | "drawing" | "table" | "checklist";

export interface SummaryRichContent {
  /** Present is proven from public bulk attachment metadata; otherwise unknown. */
  status: "present" | "unknown";
  kinds?: RichContentKind[];
  possible_kinds?: RichContentKind[];
  unknown_kinds: RichContentKind[];
}

export interface DetailRichContent {
  /** Locked notes remain unknown because their body is never fetched. */
  status: "present" | "none" | "unknown";
  kinds?: RichContentKind[];
  unknown_kinds?: RichContentKind[];
}

export interface NoteSummary extends NoteLocation {
  id: string;
  name: string;
  modified: string;
  revision: string;
  locked: boolean;
  shared: boolean;
  rich_content: SummaryRichContent;
}

export interface NoteDetail extends NoteLocation {
  id: string;
  name: string;
  modified: string;
  revision: string;
  locked: boolean;
  shared: boolean;
  created: string;
  plaintext?: string;
  rich_content: DetailRichContent;
  content_available: boolean;
  unavailable_reason?: "locked";
  page: {
    offset: number;
    returned_chars: number;
    total_chars?: number;
    truncated: boolean;
    next_offset?: number;
  };
}
