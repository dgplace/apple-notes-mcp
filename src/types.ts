export interface NoteSummary {
  id: string;
  name: string;
  folder?: string;
  modified: string;
}

export interface NoteDetail extends NoteSummary {
  created: string;
  plaintext: string;
}
