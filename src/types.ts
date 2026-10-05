export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';

/** 修订来源：馆内主档 / 现场批次 / 合并生成 */
export type RevisionSource = 'master' | 'field' | 'merged';

export interface Provenance {
  source: RevisionSource;
  batchId?: string;
  revision: number;
}

export interface ArchiveRecord {
  id: string;
  group: RecordGroup;
  title: string;
  date: string;
  people: string[];
  places: string[];
  identifier: string;
  medium: string;
  extent: string;
  rights: string;
  notes: string;
  updatedAt: string;
  status: 'unreviewed' | 'confirmed' | 'rejected' | 'merged';
  provenance: Provenance;
}

export interface MatchCandidate {
  id: string;
  leftId: string;
  rightId: string;
  score: number;
  fieldScores: Record<FieldKey, number>;
  status: MatchStatus;
  reasons: string[];
  reviewedAt?: string;
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  /** 修订来源说明，如「现场批次 FIELD-251005」，缺省为馆内主档 */
  source?: string;
  before?: string;
  after?: string;
}

/** 现场批次对单条记录的改稿：按记录编号定位，baseValues 为离场时基线值 */
export interface FieldEdit {
  identifier: string;
  changes: Partial<Record<FieldKey, string>>;
  baseValues?: Partial<Record<FieldKey, string>>;
}

/** 现场批次带回的修订包：记录主档基线号与本地改稿 */
export interface RevisionPackage {
  id: string;
  batchId: string;
  baselineRevision: number;
  createdAt: string;
  edits: FieldEdit[];
}

export type ImportJobStatus = 'importing' | 'interrupted' | 'failed' | 'completed' | 'rolled-back';

/** 修订包导入进度：分批处理，中断后可从 completedBatches 续作 */
export interface ImportJob {
  id: string;
  packageId: string;
  batchId: string;
  baselineRevision: number;
  masterRevisionAtStart: number;
  status: ImportJobStatus;
  totalEdits: number;
  processedEdits: number;
  totalBatches: number;
  completedBatches: number;
  adoptedCount: number;
  keptCount: number;
  conflictCount: number;
  addedCount: number;
  unchangedCount: number;
  pauseRequested: boolean;
  rollbackId: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

/** 双边都改过的字段冲突：并列保留三方值，人工选定来源后才放行 */
export interface MergeConflict {
  id: string;
  packageId: string;
  batchId: string;
  baselineRevision: number;
  identifier: string;
  recordId: string;
  field: FieldKey;
  baseValue: string;
  masterValue: string;
  fieldValue: string;
  status: 'pending' | 'resolved';
  resolution?: 'master' | 'field';
  resolvedAt?: string;
}

/** 导入前留下的回滚点，导入或写入中断后可回到这里 */
export interface RollbackPoint {
  id: string;
  label: string;
  revision: number;
  snapshot: string;
  createdAt: string;
}

/** 校验失败或导入失败的修订包，留在工作区供修正后重试 */
export interface FailedPackage {
  id: string;
  at: string;
  fileName: string;
  error: string;
  raw: string;
}

export interface ArchiveState {
  revision: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
  packages: RevisionPackage[];
  jobs: ImportJob[];
  conflicts: MergeConflict[];
  rollbackPoints: RollbackPoint[];
  failedPackages: FailedPackage[];
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
}
