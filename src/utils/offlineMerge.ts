import type {
  ArchiveRecord,
  ArchiveState,
  FieldBatch,
  FieldEdit,
  FieldKey,
  MergeConflict,
  RevisionPackage
} from '../types';
import { fieldValue } from './matching';

/** 大批量导入时的分批粒度 */
export const IMPORT_CHUNK = 20;

export const fieldKeys: FieldKey[] = ['title', 'date', 'people', 'places', 'identifier', 'medium', 'extent', 'rights', 'notes'];

const listFields: FieldKey[] = ['people', 'places'];

const splitList = (value: string) => value.split(/[；;、,，]/).map((item) => item.trim()).filter(Boolean);

/** 把字符串形式的字段值写回记录（列表字段拆回数组） */
export const writeField = (record: ArchiveRecord, field: FieldKey, value: string) => {
  const target = record as unknown as Record<string, string | string[]>;
  target[field] = listFields.includes(field) ? splitList(value) : value;
};

/** 取记录当前全部字段的字符串快照，作为批次基线 */
export const snapshotFields = (record: ArchiveRecord): Partial<Record<FieldKey, string>> => {
  const snap: Partial<Record<FieldKey, string>> = {};
  fieldKeys.forEach((field) => { snap[field] = fieldValue(record, field); });
  return snap;
};

export const buildRevisionPackage = (batch: FieldBatch): RevisionPackage => ({
  format: 'sologsb-revision-package',
  version: 1,
  batchId: batch.id,
  batchName: batch.name,
  baselineRevision: batch.baselineRevision,
  exportedAt: new Date().toISOString(),
  edits: batch.edits
});

export const parseRevisionPackage = (raw: string): RevisionPackage => {
  const data = JSON.parse(raw) as RevisionPackage;
  if (data?.format !== 'sologsb-revision-package' || !Array.isArray(data.edits)) {
    throw new Error('不是有效的修订包（缺少 sologsb-revision-package 头或 edits 列表）');
  }
  return data;
};

export interface ApplyOutcome {
  kind: 'new-record' | 'updated' | 'conflict' | 'unchanged';
  recordId?: string;
  adoptedFields: FieldKey[];
  conflicts: MergeConflict[];
}

/**
 * 三方合并一条现场改稿：
 * - 字段只有现场改过（主档仍等于基线）→ 直接采纳；
 * - 字段只有主档改过（现场值仍等于基线）→ 保留主档；
 * - 两边都改过且不一致 → 生成冲突，并列保留双方值与基线原值，主档记录不被覆盖。
 */
export const applyFieldEdit = (
  state: Pick<ArchiveState, 'records' | 'conflicts' | 'revision'>,
  edit: FieldEdit,
  batchName: string
): ApplyOutcome => {
  const master = state.records.find((record) => record.identifier === edit.recordKey && record.origin === 'master')
    ?? state.records.find((record) => record.identifier === edit.recordKey);
  const now = new Date().toISOString();

  if (!master) {
    const record: ArchiveRecord = {
      id: crypto.randomUUID(),
      group: 'B',
      title: edit.changed.title || `现场新记录 ${edit.recordKey}`,
      date: edit.changed.date || '',
      people: splitList(edit.changed.people || ''),
      places: splitList(edit.changed.places || ''),
      identifier: edit.recordKey,
      medium: edit.changed.medium || '',
      extent: edit.changed.extent || '',
      rights: edit.changed.rights || '',
      notes: edit.changed.notes || '',
      updatedAt: now,
      status: 'unreviewed',
      origin: 'field',
      revision: state.revision
    };
    state.records.push(record);
    return { kind: 'new-record', recordId: record.id, adoptedFields: [], conflicts: [] };
  }

  const adopted: FieldKey[] = [];
  const conflicts: MergeConflict[] = [];
  (Object.keys(edit.changed) as FieldKey[]).forEach((field) => {
    const base = edit.base[field] ?? '';
    const next = edit.changed[field] ?? '';
    const current = fieldValue(master, field);
    if (next === current) return;
    if (current === base) {
      writeField(master, field, next);
      adopted.push(field);
    } else if (next !== base) {
      conflicts.push({
        id: crypto.randomUUID(),
        recordKey: edit.recordKey,
        recordId: master.id,
        field,
        baseValue: base,
        masterValue: current,
        fieldValue: next,
        batchName,
        status: 'pending'
      });
    }
  });

  if (conflicts.length) state.conflicts.push(...conflicts);
  if (adopted.length) {
    master.revision = state.revision;
    master.updatedAt = now;
  }
  return {
    kind: conflicts.length ? 'conflict' : adopted.length ? 'updated' : 'unchanged',
    recordId: master.id,
    adoptedFields: adopted,
    conflicts
  };
};

export interface WorkspaceSnapshot {
  revision: number;
  records: ArchiveRecord[];
  matches: ArchiveState['matches'];
  merges: ArchiveState['merges'];
  conflicts: MergeConflict[];
}

/** 回滚点：任务开始前的工作区内容 */
export const takeSnapshot = (state: ArchiveState): string => JSON.stringify({
  revision: state.revision,
  records: state.records,
  matches: state.matches,
  merges: state.merges,
  conflicts: state.conflicts
} satisfies WorkspaceSnapshot);

export const restoreSnapshot = (state: ArchiveState, raw: string) => {
  const snap = JSON.parse(raw) as WorkspaceSnapshot;
  state.revision = snap.revision;
  state.records = snap.records;
  state.matches = snap.matches;
  state.merges = snap.merges;
  state.conflicts = snap.conflicts;
};
