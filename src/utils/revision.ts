import type { ArchiveRecord, FieldEdit, FieldKey, Provenance, RevisionPackage } from '../types';
import { fieldValue } from './matching';

/** 大批量导入时分批处理的每批改稿条数 */
export const IMPORT_BATCH_SIZE = 20;

export const fieldKeys: FieldKey[] = ['title', 'date', 'people', 'places', 'identifier', 'medium', 'extent', 'rights', 'notes'];

export const fieldLabels: Record<FieldKey, string> = {
  title: '标题', date: '日期', people: '人物', places: '地点', identifier: '编号',
  medium: '载体', extent: '数量', rights: '权利', notes: '备注'
};

/**
 * 三方合并决策：
 * - 两边一致：无需处理
 * - 只有现场批次改过（主档仍等于基线）：直接采纳现场值
 * - 只有馆内主档改过（现场仍等于基线）：保留主档值
 * - 两边都改过且不一致：冲突，并列保留，等人工选定事实来源
 */
export type MergeDecision = 'unchanged' | 'adopt-field' | 'keep-master' | 'conflict';

export function decideField(baseValue: string, masterValue: string, fieldValue_: string): MergeDecision {
  if (masterValue === fieldValue_) return 'unchanged';
  if (masterValue === baseValue) return 'adopt-field';
  if (fieldValue_ === baseValue) return 'keep-master';
  return 'conflict';
}

export function setRecordField(record: ArchiveRecord, field: FieldKey, value: string) {
  if (field === 'people' || field === 'places') {
    record[field] = value.split(/[；;、,，]/).map((item) => item.trim()).filter(Boolean);
  } else {
    record[field] = value;
  }
}

export const provenanceLabel = (provenance: Provenance | undefined): string => {
  if (!provenance) return '馆内主档';
  if (provenance.source === 'field') return `现场批次 ${provenance.batchId ?? '未知'} · r${provenance.revision}`;
  if (provenance.source === 'merged') return `合并生成 · r${provenance.revision}`;
  return `馆内主档 · r${provenance.revision}`;
};

export type PackageParseResult = { ok: true; pkg: RevisionPackage } | { ok: false; error: string };

const sanitizeFieldMap = (input: unknown): Partial<Record<FieldKey, string>> => {
  const output: Partial<Record<FieldKey, string>> = {};
  if (!input || typeof input !== 'object') return output;
  fieldKeys.forEach((key) => {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string') output[key] = value;
    else if (Array.isArray(value)) output[key] = value.map(String).join('、');
  });
  return output;
};

/** 校验现场批次带回的修订包，失败时返回可读原因供留存重试 */
export function parseRevisionPackage(raw: string): PackageParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: '不是合法的 JSON 文本' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '修订包必须是 JSON 对象' };
  const candidate = data as Record<string, unknown>;
  if (typeof candidate.batchId !== 'string' || !candidate.batchId.trim()) return { ok: false, error: '缺少批次号 batchId' };
  if (typeof candidate.baselineRevision !== 'number' || candidate.baselineRevision < 0) return { ok: false, error: '缺少主档基线号 baselineRevision（数字）' };
  if (!Array.isArray(candidate.edits) || !candidate.edits.length) return { ok: false, error: 'edits 必须是非空数组' };
  const edits: FieldEdit[] = [];
  for (let index = 0; index < candidate.edits.length; index += 1) {
    const item = candidate.edits[index] as Record<string, unknown>;
    if (!item || typeof item.identifier !== 'string' || !item.identifier.trim()) {
      return { ok: false, error: `第 ${index + 1} 条改稿缺少记录编号 identifier` };
    }
    const changes = sanitizeFieldMap(item.changes);
    if (!Object.keys(changes).length) return { ok: false, error: `第 ${index + 1} 条改稿（${item.identifier}）没有有效字段` };
    edits.push({ identifier: item.identifier.trim(), changes, baseValues: sanitizeFieldMap(item.baseValues) });
  }
  return {
    ok: true,
    pkg: {
      id: crypto.randomUUID(),
      batchId: candidate.batchId.trim(),
      baselineRevision: candidate.baselineRevision,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
      edits
    }
  };
}

/**
 * 生成一个示例修订包，用于离线演示三方合并：
 * 调用前主档应已产生两处“馆内改稿”，此处以旧基线值构造改稿，
 * 会同时覆盖自动采纳、保留主档、双边冲突和现场新增四种情形。
 */
export function buildSamplePackage(baselineRevision: number): RevisionPackage {
  const today = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  return {
    id: crypto.randomUUID(),
    batchId: `FIELD-${today}`,
    baselineRevision,
    createdAt: new Date().toISOString(),
    edits: [
      {
        identifier: 'OH-ZHL-2020-04',
        baseValues: { notes: '需补充授权确认', rights: '未签授权文件' },
        changes: { notes: '现场核实：授权书已邮寄，待归档', rights: '家属口头授权，待补签' }
      },
      {
        identifier: 'OH-YQF-2018-A',
        baseValues: { notes: '' },
        changes: { notes: '' }
      },
      {
        identifier: 'OH-LXZ-2019-01',
        baseValues: { extent: '02:14:38' },
        changes: { extent: '02:14:38（三段音频）' }
      },
      {
        identifier: 'MS-WDH-17',
        baseValues: { places: '白沙镇、老渡口' },
        changes: { places: '白沙镇、老渡口、新码头' }
      },
      {
        identifier: 'OH-XWJ-2026-01',
        changes: {
          title: '谢文锦渡口见闻口述', date: '2026-03-14', people: '谢文锦', places: '白沙镇',
          medium: '数字录音', extent: '00:48:12', rights: '研究者授权', notes: '现场批次新采集，待馆内核对'
        }
      }
    ]
  };
}

export { fieldValue };
