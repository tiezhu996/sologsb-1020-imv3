export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';

/** 修订来源：馆内主档 / 现场批次 / 系统动作 */
export type RevisionSource = 'master' | 'field' | 'system';

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
  /** 这条记录当前内容来自哪一侧修订线 */
  origin: 'master' | 'field';
  /** 最后一次改动落在哪个主档修订号上 */
  revision: number;
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
  /** 该动作属于哪条修订线 */
  source: RevisionSource;
  before?: string;
  after?: string;
}

/** 现场批次里针对一条记录（按编号定位）的本地改稿 */
export interface FieldEdit {
  recordKey: string;
  isNew: boolean;
  /** 基线（出发时主档）各字段原值 */
  base: Partial<Record<FieldKey, string>>;
  /** 现场改动后的字段值 */
  changed: Partial<Record<FieldKey, string>>;
  note?: string;
}

/** 现场审校批次：记录主档基线号与本地改稿 */
export interface FieldBatch {
  id: string;
  name: string;
  baselineRevision: number;
  createdAt: string;
  edits: FieldEdit[];
  exportedAt?: string;
}

/** 两边都改过同一字段时产生的冲突，裁决前挡住确认 / 合并 */
export interface MergeConflict {
  id: string;
  recordKey: string;
  recordId: string;
  field: FieldKey;
  /** 基线原值 */
  baseValue: string;
  /** 主档现值 */
  masterValue: string;
  /** 现场改稿值 */
  fieldValue: string;
  batchName: string;
  status: 'pending' | 'resolved';
  resolution?: 'master' | 'field' | 'combine';
  resolvedAt?: string;
}

export type MergeJobStatus = 'running' | 'interrupted' | 'failed' | 'done' | 'rolledback';

/** 修订包导入任务：进度、失败包与回滚点都留在工作区供断点重试 */
export interface MergeJob {
  id: string;
  packageName: string;
  batchName: string;
  baselineRevision: number;
  total: number;
  processed: number;
  status: MergeJobStatus;
  error?: string;
  /** 任务开始前的工作区快照（回滚点） */
  snapshot: string;
  /** 原始修订包内容，失败 / 中断后可原样重试 */
  packageRaw: string;
  startedAt: string;
  updatedAt: string;
}

/** 现场批次导出的修订包格式 */
export interface RevisionPackage {
  format: 'sologsb-revision-package';
  version: 1;
  batchId: string;
  batchName: string;
  baselineRevision: number;
  exportedAt: string;
  edits: FieldEdit[];
}

export interface ArchiveState {
  revision: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
  conflicts: MergeConflict[];
  batches: FieldBatch[];
  activeBatchId: string;
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
}
