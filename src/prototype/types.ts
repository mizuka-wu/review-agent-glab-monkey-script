export type PanelTab = 'chat' | 'review' | 'settings';

export type RuntimeMode = 'browser' | 'gateway';

export type ReviewStatus =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'normalizing'
  | 'completed'
  | 'cancelled';

export interface SelectionContext {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachment?: SelectionContext;
}

export interface DiffLine {
  oldLine?: number;
  newLine?: number;
  kind: 'context' | 'added' | 'removed';
  text: string;
}

export interface FindingEvidence {
  path: string;
  lines: string;
  quote: string;
}

export interface Finding {
  id: string;
  path: string;
  line: number;
  endLine: number;
  category: 'bug' | 'security' | 'performance' | 'maintainability' | 'test';
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: 'high' | 'medium' | 'low';
  title: string;
  content: string;
  evidence: FindingEvidence[];
  existingCode: string;
  suggestionCode: string;
  comment: string;
  status: 'draft' | 'ignored' | 'published';
}

export interface ToolbarState extends SelectionContext {
  top: number;
  left: number;
}
