export interface HumanFile { text: string; version: number; mtime: number }
export interface State {
  masterRevision: number;
  humanBaseRevision: number;
  draftVersion: number;
  draftMtime: number;
  runtime?: { mode: 'vscode-worker'; node: string; electron: string | null; sqlite: 'available'; threadId: number };
  aiNotification?: { sequence: number; status: 'submitted' | 'conflict' | 'pending'; masterRevision: number; conflictId?: string };
  pendingCount: number;
  activeConflict?: { id: string; masterRevision: number; draftVersion: number; openedAt: number };
  unpushed: boolean;
  updateAvailable: boolean;
  sequence: number;
  conflicts: Conflict[];
  drift?: string;
  masterFile: string;
  initialReview: 'approved' | 'unreviewed';
  reviewCount: number;
  draftReviewCount: number;
  issueCount: number;
  phase: 5;
}
export interface Conflict {
  id: string;
  kind: 'human-push' | 'human-pull' | 'ai-push';
  sessionId?: string;
  status: 'open' | 'resolved';
  revision: number;
  draftVersion: number;
  createdAt: number;
  directory: string;
  preparedDirectory?: string;
  preparedRevision?: number;
  details: unknown[];
}
export interface PushResult { ok: boolean; masterRevision: number; conflictId?: string; draftVersion?: number }
export interface DraftMutation { expectedDraftVersion: number }
export interface HumanView extends HumanFile { reviews: Review[]; issues: Issue[] }
export interface IssueDeletion extends DraftMutation { action: 'delete'; id: string; expectedVersion: number }
export interface PullResult extends PushResult { text?: string; staleIssueDeletes?: string[] }
export interface Review {
  origin?: 'initial' | 'manual';
  id: string;
  eventId: string;
  start: number; // UTF-16 offsets in the requested snapshot
  end: number;
  kind: 'token' | 'paragraph' | 'structure';
  status: 'unreviewed' | 'needsFix';
  version: string;
  contentHash: string;
  text: string;
  initialText: string;
  original: string | null;
  revision: number;
}
export interface Issue {
  id: string;
  type: 'anchored' | 'general';
  title: string;
  description: string;
  status: 'open' | 'resolved';
  version: number;
  createdAt: number;
  conflictId?: string;
  anchor?: { type: 'line' | 'paragraph'; start: number; end: number; label?: string; fingerprint: string; ordinal: number };
}
