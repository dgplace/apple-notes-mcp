export interface EntityIdentity {
  id: string;
  name: string;
}

export interface NoteLocation {
  account: EntityIdentity;
  folder: EntityIdentity;
}

export interface NoteSummary extends NoteLocation {
  id: string;
  name: string;
  modified: string;
}

export interface NoteDetail extends NoteSummary {
  created: string;
  plaintext: string;
}
