import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type {
  ArchiveRecord, ArchiveState, FieldEdit, FieldKey, ImportJob, MatchCandidate,
  MergeConflict, RecordGroup, RevisionPackage
} from './types';
import { computeMatches, fieldValue, reconcileMatches } from './utils/matching';
import {
  IMPORT_BATCH_SIZE, buildSamplePackage, decideField, fieldLabels as fieldLabelMap,
  parseRevisionPackage, provenanceLabel, setRecordField
} from './utils/revision';
import { seedState } from './data/seed';

const STORAGE_KEY = 'sologsb-1020-archive-state-v1';
const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);
const matchLabel = (state: ArchiveState, match: MatchCandidate) => {
  const left = recordById(state, match.leftId);
  const right = recordById(state, match.rightId);
  return `${left?.title ?? '未知记录'} ↔ ${right?.title ?? '未知记录'}`;
};
const jobStatusLabel = (status: ImportJob['status']) => ({
  importing: '导入中', interrupted: '已中断 · 可续作', failed: '失败', completed: '已完成', 'rolled-back': '已回滚'
})[status];

export default component$(() => {
  const state = useStore<ArchiveState>(seedState());
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | 'suggested' | 'confirmed' | 'rejected'>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const pkgOpen = useSignal(false);
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const pkgRaw = useSignal('');
  const pkgFileName = useSignal('');
  const persistError = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit,
    packages: state.packages,
    jobs: state.jobs,
    conflicts: state.conflicts,
    failedPackages: state.failedPackages
  });

  const capture = () => {
    history.value = [...history.value.slice(-49), snapshot()];
    future.value = [];
  };

  const restore = (raw: string) => {
    const next = JSON.parse(raw) as Partial<ArchiveState>;
    state.revision = next.revision ?? state.revision;
    state.records = next.records ?? state.records;
    state.matches = next.matches ?? state.matches;
    state.merges = next.merges ?? state.merges;
    state.audit = next.audit ?? state.audit;
    state.packages = next.packages ?? state.packages;
    state.jobs = next.jobs ?? state.jobs;
    state.conflicts = next.conflicts ?? state.conflicts;
    state.failedPackages = next.failedPackages ?? state.failedPackages;
    state.rollbackPoints = next.rollbackPoints ?? state.rollbackPoints;
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 2800);
  };

  const commit = (action: string, detail: string, recordIds: string[] = [], source?: string) => {
    state.revision += 1;
    state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail, recordIds, source });
    state.audit = state.audit.slice(0, 300);
  };

  const undo = $(() => {
    const raw = history.value.at(-1);
    if (!raw) return;
    future.value = [...future.value, snapshot()];
    history.value = history.value.slice(0, -1);
    restore(raw);
  });

  const redo = $(() => {
    const raw = future.value.at(-1);
    if (!raw) return;
    history.value = [...history.value, snapshot()];
    future.value = future.value.slice(0, -1);
    restore(raw);
  });

  const filteredRecords = useComputed$(() => {
    const term = query.value.trim().toLowerCase();
    return state.records
      .filter((record) => groupFilter.value === 'all' || record.group === groupFilter.value)
      .filter((record) => !term || [record.title, record.date, record.identifier, ...record.people, ...record.places].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, visibleCount.value);
  });

  const filteredMatches = useComputed$(() => state.matches
    .filter((match) => statusFilter.value === 'all' || match.status === statusFilter.value)
    .sort((a, b) => b.score - a.score));

  const visibleMatches = useComputed$(() => filteredMatches.value.slice(0, 120));
  const activeMatch = useComputed$(() => state.matches.find((match) => match.id === state.activeMatchId) ?? filteredMatches.value[0]);
  const conflictCount = useComputed$(() => state.matches.filter((match) => match.status === 'suggested' && match.score < .68).length);

  /** 存在待裁决字段冲突的记录：确认与合并一律挡住，等人工选定事实来源 */
  const lockedRecordIds = useComputed$(() => new Set(
    state.conflicts.filter((item) => item.status === 'pending').map((item) => item.recordId)
  ));
  const pendingConflictCount = useComputed$(() => state.conflicts.filter((item) => item.status === 'pending').length);
  const sortedConflicts = useComputed$(() => [...state.conflicts]
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'pending' ? -1 : 1))
    .slice(0, 80));
  const matchLocked = (match: MatchCandidate) => lockedRecordIds.value.has(match.leftId) || lockedRecordIds.value.has(match.rightId);

  const updateMatch = $((id: string, status: MatchCandidate['status']) => {
    const match = state.matches.find((item) => item.id === id);
    if (!match) return;
    if (status === 'confirmed' && matchLocked(match)) {
      notify('该匹配涉及未裁决的修订冲突，已挡住确认，请先在冲突队列选定事实来源');
      return;
    }
    capture();
    match.status = status;
    match.reviewedAt = new Date().toISOString();
    state.records.forEach((record) => {
      if ((record.id === match.leftId || record.id === match.rightId) && status === 'confirmed') record.status = 'confirmed';
    });
    commit(status === 'confirmed' ? '确认匹配' : '忽略可疑匹配', matchLabel(state, match), [match.leftId, match.rightId]);
    notify(status === 'confirmed' ? '已确认此项匹配' : '已忽略此项匹配');
  });

  const bulkMatch = $((status: MatchCandidate['status']) => {
    const ids = selectedMatchIds.value;
    if (!ids.length) return;
    const blocked = ids.filter((id) => {
      const match = state.matches.find((item) => item.id === id);
      return match ? matchLocked(match) : false;
    });
    const actionable = status === 'confirmed' ? ids.filter((id) => !blocked.includes(id)) : ids;
    if (!actionable.length) {
      notify('所选匹配都含有未裁决的修订冲突，已挡住批量确认');
      return;
    }
    capture();
    actionable.forEach((id) => {
      const match = state.matches.find((item) => item.id === id);
      if (!match) return;
      match.status = status;
      match.reviewedAt = new Date().toISOString();
    });
    commit('批量复核', `${actionable.length} 条匹配被标记为${status === 'confirmed' ? '确认' : '忽略'}${blocked.length ? `，${blocked.length} 条因未裁决冲突被挡住` : ''}`, actionable.flatMap((id) => {
      const match = state.matches.find((item) => item.id === id);
      return match ? [match.leftId, match.rightId] : [];
    }));
    selectedMatchIds.value = [];
    notify(`已批量处理 ${actionable.length} 条匹配${blocked.length ? `，挡住 ${blocked.length} 条冲突项` : ''}`);
  });

  const openMerge = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    if (matchLocked(match)) {
      notify('该匹配涉及未裁决的修订冲突，已挡住合并，请先在冲突队列选定事实来源');
      return;
    }
    state.activeMatchId = match.id;
    fieldLabels.forEach(([field]) => {
      choices[field] = 'A';
    });
    mergeOpen.value = true;
  });

  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });

  const mergeCurrent = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    if (matchLocked(match)) {
      notify('存在未裁决的修订冲突，合并已被挡住');
      return;
    }
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) return;
    capture();
    const values: Partial<Record<FieldKey, string>> = {};
    fieldLabels.forEach(([field]) => {
      const source = choices[field];
      const pick = source === 'combine' ? `${fieldValue(left, field)}；${fieldValue(right, field)}` : fieldValue(source === 'A' ? left : right, field);
      values[field] = pick;
    });
    const merged: ArchiveRecord = {
      ...left,
      ...values,
      people: values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
      places: values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
      status: 'merged',
      updatedAt: new Date().toISOString(),
      provenance: { source: 'merged', revision: state.revision + 1 }
    };
    state.records = [...state.records.filter((record) => record.id !== left.id && record.id !== right.id), merged];
    state.matches.forEach((item) => {
      if (item.id === match.id) item.status = 'merged';
      else if (item.leftId === left.id || item.rightId === right.id || item.leftId === right.id || item.rightId === left.id) item.status = 'rejected';
    });
    state.merges.unshift({
      id: crypto.randomUUID(),
      matchId: match.id,
      leftId: left.id,
      rightId: right.id,
      chosen: { ...choices },
      values,
      mergedAt: new Date().toISOString()
    });
    commit('合并两条记录', `保留 ${Object.values(choices).filter((choice) => choice === 'A').length} 个 A 来源字段、${Object.values(choices).filter((choice) => choice === 'B').length} 个 B 来源字段`, [left.id, right.id, merged.id]);
    mergeOpen.value = false;
    notify('记录已合并，来源与字段选择已写入审计记录');
  });

  const parseImport = $(() => {
    const raw = importRaw.value.trim();
    if (!raw) return;
    let rows: Array<Partial<ArchiveRecord>> = [];
    try {
      if (raw.startsWith('[')) rows = JSON.parse(raw) as Array<Partial<ArchiveRecord>>;
      else {
        const lines = raw.split(/\r?\n/).filter(Boolean);
        rows = lines.map((line, index) => {
          const cells = line.split(/\t|\|/).map((cell) => cell.trim());
          return {
            title: cells[0] || `未命名记录 ${index + 1}`,
            date: cells[1] || '',
            people: (cells[2] || '').split(/[，,、]/).filter(Boolean),
            places: (cells[3] || '').split(/[，,、]/).filter(Boolean),
            identifier: cells[4] || '',
            medium: cells[5] || '',
            extent: cells[6] || '',
            rights: cells[7] || '',
            notes: cells[8] || ''
          };
        });
      }
    } catch {
      notify('导入内容格式不正确，请使用 JSON 数组或制表符分隔文本');
      return;
    }
    if (!rows.length) return;
    capture();
    rows.forEach((row) => {
      const record: ArchiveRecord = {
        id: crypto.randomUUID(),
        group: importGroup.value,
        title: row.title || '未命名记录',
        date: row.date || '',
        people: Array.isArray(row.people) ? row.people : String(row.people || '').split(/[，,、]/).filter(Boolean),
        places: Array.isArray(row.places) ? row.places : String(row.places || '').split(/[，,、]/).filter(Boolean),
        identifier: row.identifier || '',
        medium: row.medium || '',
        extent: row.extent || '',
        rights: row.rights || '',
        notes: row.notes || '',
        updatedAt: new Date().toISOString(),
        status: 'unreviewed',
        provenance: { source: 'master', revision: state.revision + 1 }
      };
      state.records.push(record);
    });
    state.matches = computeMatches(state.records);
    commit('导入档案记录', `从 ${importGroup.value} 组导入 ${rows.length} 条记录`, []);
    importRaw.value = '';
    importText.value = '';
    importOpen.value = false;
    notify(`已导入 ${rows.length} 条记录并重新匹配`);
  });

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importText.value = file.name;
  });

  /* ---------- 离线修订包：三方合并、分批导入、中断续作、回滚 ---------- */

  /** 应用单条现场改稿：按编号定位主档记录，逐字段三方合并，绝不覆盖另一侧数据 */
  const applyEdit = (edit: FieldEdit, pkg: RevisionPackage, job: ImportJob) => {
    const record = state.records.find((item) => item.identifier === edit.identifier);
    const now = new Date().toISOString();
    if (!record) {
      const added: ArchiveRecord = {
        id: crypto.randomUUID(),
        group: 'B',
        title: edit.changes.title || `现场新记录 ${edit.identifier}`,
        date: edit.changes.date || '',
        people: (edit.changes.people || '').split(/[；;、,，]/).map((item) => item.trim()).filter(Boolean),
        places: (edit.changes.places || '').split(/[；;、,，]/).map((item) => item.trim()).filter(Boolean),
        identifier: edit.identifier,
        medium: edit.changes.medium || '',
        extent: edit.changes.extent || '',
        rights: edit.changes.rights || '',
        notes: edit.changes.notes || '',
        updatedAt: now,
        status: 'unreviewed',
        provenance: { source: 'field', batchId: pkg.batchId, revision: state.revision + 1 }
      };
      state.records.push(added);
      job.addedCount += 1;
      return;
    }
    (Object.keys(edit.changes) as FieldKey[]).forEach((field) => {
      const masterValue = fieldValue(record, field);
      const baseValue = edit.baseValues?.[field] ?? masterValue;
      const nextValue = edit.changes[field] ?? '';
      const decision = decideField(baseValue, masterValue, nextValue);
      if (decision === 'unchanged') { job.unchangedCount += 1; return; }
      if (decision === 'keep-master') { job.keptCount += 1; return; }
      if (decision === 'adopt-field') {
        setRecordField(record, field, nextValue);
        record.updatedAt = now;
        record.provenance = { source: 'field', batchId: pkg.batchId, revision: state.revision + 1 };
        job.adoptedCount += 1;
        return;
      }
      const existing = state.conflicts.find((item) => item.status === 'pending' && item.recordId === record.id && item.field === field);
      if (existing) {
        existing.masterValue = masterValue;
        existing.fieldValue = nextValue;
        return;
      }
      const conflict: MergeConflict = {
        id: crypto.randomUUID(),
        packageId: pkg.id,
        batchId: pkg.batchId,
        baselineRevision: pkg.baselineRevision,
        identifier: edit.identifier,
        recordId: record.id,
        field,
        baseValue,
        masterValue,
        fieldValue: nextValue,
        status: 'pending'
      };
      state.conflicts.unshift(conflict);
      job.conflictCount += 1;
    });
  };

  /** 分批执行导入：每批落一次进度，暂停、断网或写入失败都能从 completedBatches 续作 */
  const runImportJob = $(async (jobId: string) => {
    const job = state.jobs.find((item) => item.id === jobId);
    const pkg = state.packages.find((item) => item.id === job?.packageId);
    if (!job || !pkg) return;
    job.status = 'importing';
    job.error = '';
    job.totalBatches = Math.max(1, Math.ceil(pkg.edits.length / IMPORT_BATCH_SIZE));
    job.updatedAt = new Date().toISOString();
    while (job.completedBatches < job.totalBatches) {
      if (job.pauseRequested) {
        job.pauseRequested = false;
        job.status = 'interrupted';
        job.updatedAt = new Date().toISOString();
        commit('导入已暂停', `批次 ${job.batchId} 完成 ${job.completedBatches}/${job.totalBatches} 批，进度与回滚点已留存`, [], `现场批次 ${job.batchId}`);
        notify('导入已暂停，进度与回滚点留在工作区，可随时续作');
        return;
      }
      const start = job.completedBatches * IMPORT_BATCH_SIZE;
      const slice = pkg.edits.slice(start, start + IMPORT_BATCH_SIZE);
      try {
        slice.forEach((edit) => applyEdit(edit, pkg, job));
        job.completedBatches += 1;
        job.processedEdits = Math.min(pkg.edits.length, start + slice.length);
        job.updatedAt = new Date().toISOString();
        commit('导入分批完成', `批次 ${job.batchId} 第 ${job.completedBatches}/${job.totalBatches} 批（${slice.length} 条改稿）`, [], `现场批次 ${job.batchId}`);
      } catch (error) {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
        job.updatedAt = new Date().toISOString();
        commit('修订包导入失败', `批次 ${job.batchId} 在第 ${job.completedBatches + 1} 批中断：${job.error}`, [], `现场批次 ${job.batchId}`);
        notify('导入中断，失败包、进度与回滚点已留在工作区供重试');
        return;
      }
      await sleep(30);
    }
    job.status = 'completed';
    job.updatedAt = new Date().toISOString();
    state.matches = reconcileMatches(state.matches, state.records);
    commit(
      '修订包导入完成',
      `批次 ${job.batchId}（基线 r${job.baselineRevision}）：采纳 ${job.adoptedCount} 项、保留主档 ${job.keptCount} 项、冲突 ${job.conflictCount} 项、新增 ${job.addedCount} 条`,
      [],
      `现场批次 ${job.batchId}`
    );
    notify(job.conflictCount ? `导入完成，${job.conflictCount} 个字段冲突待裁决，相关匹配已锁定` : '修订包导入完成，未产生冲突');
  });

  /** 开始导入：先留回滚点，再分批三方合并，主档与现场批次互不覆盖 */
  const startImport = $(async (pkg: RevisionPackage) => {
    capture();
    state.packages.push(pkg);
    const rollbackId = crypto.randomUUID();
    state.rollbackPoints.unshift({
      id: rollbackId,
      label: `导入 ${pkg.batchId} 前`,
      revision: state.revision,
      snapshot: JSON.stringify({ revision: state.revision, records: state.records, matches: state.matches, merges: state.merges }),
      createdAt: new Date().toISOString()
    });
    state.rollbackPoints = state.rollbackPoints.slice(0, 5);
    const job: ImportJob = {
      id: crypto.randomUUID(),
      packageId: pkg.id,
      batchId: pkg.batchId,
      baselineRevision: pkg.baselineRevision,
      masterRevisionAtStart: state.revision,
      status: 'importing',
      totalEdits: pkg.edits.length,
      processedEdits: 0,
      totalBatches: 0,
      completedBatches: 0,
      adoptedCount: 0,
      keptCount: 0,
      conflictCount: 0,
      addedCount: 0,
      unchangedCount: 0,
      pauseRequested: false,
      rollbackId,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    state.jobs.unshift(job);
    const drift = state.revision - pkg.baselineRevision;
    commit(
      '开始导入修订包',
      `批次 ${pkg.batchId} · 基线 r${pkg.baselineRevision} · ${pkg.edits.length} 条改稿${drift > 0 ? ` · 主档已前进 ${drift} 个修订，按字段三方合并` : ''}`,
      [],
      `现场批次 ${pkg.batchId}`
    );
    await runImportJob(job.id);
  });

  const resumeJob = $(async (jobId: string) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job || job.status === 'importing' || job.status === 'completed') return;
    commit('续作修订包导入', `批次 ${job.batchId} 从第 ${job.completedBatches + 1} 批继续`, [], `现场批次 ${job.batchId}`);
    await runImportJob(jobId);
  });

  const rollbackJob = $((jobId: string) => {
    const job = state.jobs.find((item) => item.id === jobId);
    const point = state.rollbackPoints.find((item) => item.id === job?.rollbackId);
    if (!job || !point || job.status === 'importing') return;
    capture();
    const snap = JSON.parse(point.snapshot) as Pick<ArchiveState, 'revision' | 'records' | 'matches' | 'merges'>;
    state.records = snap.records;
    state.matches = snap.matches;
    state.merges = snap.merges;
    state.revision = snap.revision;
    state.conflicts = state.conflicts.filter((item) => item.packageId !== job.packageId);
    job.status = 'rolled-back';
    job.updatedAt = new Date().toISOString();
    commit('回滚修订包导入', `批次 ${job.batchId} 已回到回滚点「${point.label}」（r${point.revision}），主档与现场批次均未覆盖对方`, [], `现场批次 ${job.batchId}`);
    notify(`已回滚到 r${point.revision}，可修正修订包后重新导入`);
  });

  /** 人工裁决冲突：选定事实来源后才放行相关匹配的确认与合并 */
  const resolveConflict = $((id: string, choice: 'master' | 'field') => {
    const conflict = state.conflicts.find((item) => item.id === id);
    if (!conflict || conflict.status !== 'pending') return;
    capture();
    conflict.status = 'resolved';
    conflict.resolution = choice;
    conflict.resolvedAt = new Date().toISOString();
    const record = recordById(state, conflict.recordId);
    if (choice === 'field' && record) {
      setRecordField(record, conflict.field, conflict.fieldValue);
      record.updatedAt = new Date().toISOString();
      record.provenance = { source: 'field', batchId: conflict.batchId, revision: state.revision + 1 };
    }
    commit(
      '裁决修订冲突',
      `${conflict.identifier} · ${fieldLabelMap[conflict.field]}：采用${choice === 'field' ? `现场批次 ${conflict.batchId}` : '馆内主档'}（基线原值：${conflict.baseValue || '空'}）`,
      [conflict.recordId],
      choice === 'field' ? `现场批次 ${conflict.batchId}` : '馆内主档'
    );
    notify(pendingConflictCount.value ? '已记录事实来源，仍有冲突待裁决' : '全部冲突已裁决，相关匹配已放行');
  });

  const importRevisionPackage = $(async () => {
    const raw = pkgRaw.value.trim();
    if (!raw) return;
    const result = parseRevisionPackage(raw);
    if (!result.ok) {
      state.failedPackages.unshift({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        fileName: pkgFileName.value || '手工粘贴内容',
        error: result.error,
        raw: raw.slice(0, 4000)
      });
      state.failedPackages = state.failedPackages.slice(0, 10);
      commit('修订包校验失败', `${pkgFileName.value || '手工粘贴内容'}：${result.error}，已留存供修正后重试`);
      notify('修订包校验失败，已留在失败包列表供修正后重试');
      return;
    }
    pkgRaw.value = '';
    pkgFileName.value = '';
    pkgOpen.value = false;
    await startImport(result.pkg);
  });

  const retryFailedPackage = $(async (id: string) => {
    const failed = state.failedPackages.find((item) => item.id === id);
    if (!failed) return;
    const result = parseRevisionPackage(failed.raw);
    if (!result.ok) {
      failed.error = result.error;
      failed.at = new Date().toISOString();
      notify(`仍无法导入：${result.error}`);
      return;
    }
    state.failedPackages = state.failedPackages.filter((item) => item.id !== id);
    await startImport(result.pkg);
  });

  const discardFailedPackage = $((id: string) => {
    const failed = state.failedPackages.find((item) => item.id === id);
    state.failedPackages = state.failedPackages.filter((item) => item.id !== id);
    if (failed) commit('丢弃失败修订包', `${failed.fileName}：${failed.error}`);
  });

  const pkgFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    pkgRaw.value = await file.text();
    pkgFileName.value = file.name;
  });

  /** 示例：模拟批次离场后馆内改了两处，再导入现场修订包，覆盖四种合并情形 */
  const loadSamplePackage = $(async () => {
    capture();
    const baseline = state.revision;
    const now = new Date().toISOString();
    const touched: string[] = [];
    const zhl = state.records.find((record) => record.identifier === 'OH-ZHL-2020-04');
    if (zhl) {
      zhl.notes = '已联系张惠兰家属补签授权（馆内核实）';
      zhl.updatedAt = now;
      zhl.provenance = { source: 'master', revision: state.revision + 1 };
      touched.push(zhl.id);
    }
    const yqf = state.records.find((record) => record.identifier === 'OH-YQF-2018-A');
    if (yqf) {
      yqf.notes = '馆内补充：与 OH-2018-050 为同一采访批次';
      yqf.updatedAt = now;
      yqf.provenance = { source: 'master', revision: state.revision + 1 };
      touched.push(yqf.id);
    }
    commit('馆内主档修订', '模拟现场批次离场后，馆内对 2 条记录的改稿', touched);
    pkgOpen.value = false;
    await startImport(buildSamplePackage(baseline));
  });

  const exportAudit = $(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      generator: 'sologsb-1020-archive-reconciliation',
      revision: state.revision,
      records: state.records,
      matches: state.matches,
      merges: state.merges,
      conflicts: state.conflicts,
      importJobs: state.jobs,
      packages: state.packages.map((pkg) => ({ id: pkg.id, batchId: pkg.batchId, baselineRevision: pkg.baselineRevision, createdAt: pkg.createdAt, edits: pkg.edits.length })),
      audit: state.audit
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `档案元数据核对结果-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  const moveReview = $((delta: number) => {
    const list = filteredMatches.value;
    const index = list.findIndex((match) => match.id === activeMatch.value?.id);
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
    if (next) {
      state.activeMatchId = next.id;
      document.querySelector(`[data-match-id="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  useVisibleTask$(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<ArchiveState>;
        restore(JSON.stringify(saved));
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    const interrupted = state.jobs.filter((job) => job.status === 'importing');
    if (interrupted.length) {
      interrupted.forEach((job) => {
        job.status = 'interrupted';
        job.updatedAt = new Date().toISOString();
      });
      state.audit.unshift({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        action: '检测到中断的导入',
        detail: `${interrupted.map((job) => job.batchId).join('、')} 未完成，进度与回滚点已保留，可续作或回滚`,
        recordIds: [],
        source: '工作区恢复'
      });
    }
    state.hydrated = true;
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => JSON.stringify({
      revision: state.revision,
      records: state.records,
      matches: state.matches,
      merges: state.merges,
      audit: state.audit,
      packages: state.packages,
      jobs: state.jobs,
      conflicts: state.conflicts,
      rollbackPoints: state.rollbackPoints,
      failedPackages: state.failedPackages
    }));
    if (!state.hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, payload);
      persistError.value = '';
    } catch {
      persistError.value = '本地写入失败：当前进度与回滚点仍保留在工作区，请导出核对包备份';
    }
  });

  useVisibleTask$(({ cleanup }) => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); importOpen.value = true; return; }
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); moveReview(1); }
      if (key === 'k') { event.preventDefault(); moveReview(-1); }
      if (event.key === 'Enter' && activeMatch.value) { event.preventDefault(); openMerge(); }
      if (key === 'c' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'confirmed'); }
      if (key === 'r' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'rejected'); }
      if (key === '?' || (event.shiftKey && event.key === '/')) { event.preventDefault(); panelTab.value = 2; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat">
          <span class={`online-dot ${persistError.value ? 'error' : ''}`} />
          {persistError.value || (state.hydrated ? `离线保存 · r${state.revision}` : '正在恢复本地工作区')}
        </div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button ghost" onClick$={() => pkgOpen.value = true}>导入修订包</button>
          <button class="button light" onClick$={exportAudit}>导出核对包</button>
        </div>
      </header>

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>馆内主档与现场审校批次通过修订包离线合并：单边改直接采纳，双边改并列保留，人工选定事实来源后才放行。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          <div class="danger"><strong>{conflictCount.value}</strong><span>低分可疑项</span></div>
          <div class="danger"><strong>{pendingConflictCount.value}</strong><span>待裁决冲突</span></div>
        </div>
      </div>

      <main class="desk-grid">
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J / K 移动 · Enter 合并</span>
          </div>
          <div class="toolbar-row">
            <select class="input" value={statusFilter.value} onChange$={(event) => { statusFilter.value = (event.target as HTMLSelectElement).value as typeof statusFilter.value; }}>
              <option value="all">全部匹配</option><option value="suggested">待复核</option><option value="confirmed">已确认</option><option value="rejected">已忽略</option>
            </select>
            <button class="button small" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('confirmed')}>批量确认</button>
            <button class="button small ghost" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('rejected')}>批量忽略</button>
          </div>
          <div class="match-list">
            {visibleMatches.value.map((match) => {
              const left = recordById(state, match.leftId);
              const right = recordById(state, match.rightId);
              const isActive = () => state.activeMatchId === match.id;
              const locked = matchLocked(match);
              return (
                <article
                  data-match-id={match.id}
                  class={`match-card ${isActive() ? 'active' : ''} ${locked ? 'locked' : ''}`}
                  onClick$={() => { state.activeMatchId = match.id; }}
                  tabIndex={0}
                >
                  <div class="match-topline">
                    <Checkbox.Root
                      class="qwik-check"
                      aria-label={`选择匹配 ${match.id}`}
                      initialValue={selectedMatchIds.value.includes(match.id)}
                      onClick$={(event: Event) => {
                        event.stopPropagation();
                        selectedMatchIds.value = selectedMatchIds.value.includes(match.id)
                          ? selectedMatchIds.value.filter((id) => id !== match.id)
                          : [...selectedMatchIds.value, match.id];
                      }}
                    ><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root>
                    <span class={`score ${match.score < .68 ? 'low' : ''}`}>{Math.round(match.score * 100)}%</span>
                    <span class={`status ${match.status}`}>{match.status === 'suggested' ? '待复核' : match.status === 'confirmed' ? '已确认' : match.status === 'rejected' ? '已忽略' : '已合并'}</span>
                    {locked && <span class="status locked">冲突锁定</span>}
                    <span class="record-id">{left?.identifier}</span>
                  </div>
                  <div class="pair-preview">
                    <div><small>A 组 · {provenanceLabel(left?.provenance)}</small><strong>{left?.title}</strong><span>{parseDate(left?.date ?? '')} · {left?.people.join('、')}</span></div>
                    <i>↔</i>
                    <div><small>B 组 · {provenanceLabel(right?.provenance)}</small><strong>{right?.title}</strong><span>{parseDate(right?.date ?? '')} · {right?.people.join('、')}</span></div>
                  </div>
                  <div class="reason-line">{match.reasons.join(' · ')}</div>
                </article>
              );
            })}
            {!visibleMatches.value.length && <div class="empty-state">没有符合当前筛选条件的匹配。</div>}
          </div>
        </section>

        <section class="panel records-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / RECORD INDEX</span><h3>档案记录索引</h3></div>
            <span class="shortcut-hint">分页渲染 · 当前 {filteredRecords.value.length} 条</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜索标题、日期、人物、地点或编号" value={query.value} onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }} />
            <select class="input compact" value={groupFilter.value} onChange$={(event) => { groupFilter.value = (event.target as HTMLSelectElement).value as typeof groupFilter.value; visibleCount.value = 80; }}>
              <option value="all">A + B</option><option value="A">A 组</option><option value="B">B 组</option>
            </select>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题 / 修订来源</span><span>日期 / 人物 / 地点</span><span>编号</span><span>状态</span></div>
            {filteredRecords.value.map((record) => (
              <div class="table-row" key={record.id}>
                <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                <div class="title-cell">
                  <strong>{record.title}</strong>
                  <small class={`prov ${record.provenance?.source ?? 'master'}`}>{provenanceLabel(record.provenance)}</small>
                </div>
                <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                <code>{record.identifier}</code>
                <span class={`record-status ${record.status}`}>{record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : record.status === 'rejected' ? '已忽略' : '已合并'}</span>
              </div>
            ))}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list"><Tabs.Tab>复核详情</Tabs.Tab><Tabs.Tab>合并追溯</Tabs.Tab><Tabs.Tab>键盘帮助</Tabs.Tab></Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value ? (() => {
                const left = recordById(state, activeMatch.value!.leftId)!;
                const right = recordById(state, activeMatch.value!.rightId)!;
                const locked = matchLocked(activeMatch.value!);
                return <>
                  <div class="active-score"><span>{Math.round(activeMatch.value!.score * 100)}</span><div><strong>综合匹配分</strong><small>{activeMatch.value!.reasons.join(' · ')}</small></div></div>
                  {locked && <div class="block-note">该匹配涉及未裁决的修订冲突，确认与合并已被挡住。请先在下方「冲突裁决队列」选定事实来源。</div>}
                  <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源<small class="prov-inline">{provenanceLabel(left?.provenance)}</small></div><div>B 来源<small class="prov-inline">{provenanceLabel(right?.provenance)}</small></div>
                    {fieldLabels.map(([field, label]) => <><div class="field-label">{label}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}</div></>)}
                  </div>
                  <div class="action-stack"><button class="button primary wide" disabled={locked} onClick$={openMerge}>逐字段合并</button><div class="split-actions"><button class="button confirm" disabled={locked} onClick$={() => updateMatch(activeMatch.value!.id, 'confirmed')}>确认匹配</button><button class="button ghost" onClick$={() => updateMatch(activeMatch.value!.id, 'rejected')}>忽略</button></div></div>
                </>;
              })() : <div class="empty-state">从左侧选择一条匹配查看字段来源。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel">
              {state.merges.length ? state.merges.map((merge) => {
                const left = recordById(state, merge.leftId);
                const right = recordById(state, merge.rightId);
                return <details class="merge-log" key={merge.id}><summary>{left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}</summary><p>{new Date(merge.mergedAt).toLocaleString('zh-CN')}</p><ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>保留 {choice === 'A' ? 'A 来源' : choice === 'B' ? 'B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span></li>)}</ul></details>;
              }) : <div class="empty-state">还没有合并记录。完成一次字段合并后，来源选择会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>打开逐字段合并窗口</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div><div><kbd>Ctrl/⌘ + Enter</kbd><span>在导入框中提交记录</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="offline-grid">
        <section class="panel jobs-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">04 / OFFLINE MERGE</span><h3>修订包与导入进度</h3></div>
            <span class="shortcut-hint">分批导入 · 中断可续作</span>
          </div>
          <div class="toolbar-row">
            <button class="button small" onClick$={() => pkgOpen.value = true}>导入修订包</button>
            <button class="button small ghost" onClick$={loadSamplePackage}>载入示例修订包</button>
            <span class="toolbar-note">主档当前 r{state.revision} · 回滚点 {state.rollbackPoints.length} 个</span>
          </div>
          <div class="job-list">
            {state.jobs.map((job) => {
              const point = state.rollbackPoints.find((item) => item.id === job.rollbackId);
              const percent = job.totalEdits ? Math.round((job.processedEdits / job.totalEdits) * 100) : 0;
              return (
                <article class={`job-card ${job.status}`} key={job.id}>
                  <div class="job-topline">
                    <strong>{job.batchId}</strong>
                    <span class={`job-status ${job.status}`}>{jobStatusLabel(job.status)}</span>
                    <span class="job-rev">基线 r{job.baselineRevision} → 主档 r{job.masterRevisionAtStart}</span>
                  </div>
                  <div class="progress"><i style={{ width: `${percent}%` }} /></div>
                  <div class="job-meta">
                    <span>改稿 {job.processedEdits}/{job.totalEdits}</span>
                    <span>分批 {job.completedBatches}/{job.totalBatches}</span>
                    <span>采纳 {job.adoptedCount}</span>
                    <span>留主档 {job.keptCount}</span>
                    <span>冲突 {job.conflictCount}</span>
                    <span>新增 {job.addedCount}</span>
                  </div>
                  {job.error && <p class="job-error">中断原因：{job.error}（进度已留存，可重试）</p>}
                  <div class="job-actions">
                    {job.status === 'importing' && <button class="button small ghost" onClick$={() => { job.pauseRequested = true; }}>暂停</button>}
                    {(job.status === 'interrupted' || job.status === 'failed') && <button class="button small" onClick$={() => resumeJob(job.id)}>继续导入</button>}
                    {job.status !== 'rolled-back' && job.status !== 'importing' && point && <button class="button small danger" onClick$={() => rollbackJob(job.id)}>回滚到 r{point.revision}</button>}
                    {job.status === 'rolled-back' && <span class="job-note">已回到回滚点，可修正修订包后重新导入</span>}
                  </div>
                </article>
              );
            })}
            {state.failedPackages.map((failed) => (
              <article class="job-card failed" key={failed.id}>
                <div class="job-topline">
                  <strong>{failed.fileName}</strong>
                  <span class="job-status failed">校验失败</span>
                  <span class="job-rev">{new Date(failed.at).toLocaleString('zh-CN')}</span>
                </div>
                <p class="job-error">{failed.error}。失败包已留在工作区，修正后可重试。</p>
                <div class="job-actions">
                  <button class="button small" onClick$={() => retryFailedPackage(failed.id)}>重试导入</button>
                  <button class="button small ghost" onClick$={() => discardFailedPackage(failed.id)}>丢弃</button>
                </div>
              </article>
            ))}
            {!state.jobs.length && !state.failedPackages.length && (
              <div class="empty-state">还没有导入过修订包。现场批次带回的修订包会按记录编号与主档做三方合并，分批处理，中断后从这里续作或回滚。</div>
            )}
          </div>
        </section>

        <section class="panel conflict-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">05 / CONFLICTS</span><h3>冲突裁决队列</h3></div>
            <span>{pendingConflictCount.value} 项待裁决</span>
          </div>
          <div class="conflict-list">
            {sortedConflicts.value.map((conflict) => (
              <article class={`conflict-card ${conflict.status}`} key={conflict.id}>
                <div class="conflict-topline">
                  <code>{conflict.identifier}</code>
                  <strong>{fieldLabelMap[conflict.field]}</strong>
                  <span class={`job-status ${conflict.status === 'pending' ? 'interrupted' : 'completed'}`}>
                    {conflict.status === 'pending' ? '待裁决' : `已采用${conflict.resolution === 'field' ? '现场批次' : '馆内主档'}`}
                  </span>
                </div>
                <div class="conflict-values">
                  <div class="value base"><small>原值 · 基线 r{conflict.baselineRevision}</small><p>{conflict.baseValue || '（空）'}</p></div>
                  <div class={`value master ${conflict.resolution === 'master' ? 'chosen' : ''}`}><small>馆内主档</small><p>{conflict.masterValue || '（空）'}</p></div>
                  <div class={`value field ${conflict.resolution === 'field' ? 'chosen' : ''}`}><small>现场批次 {conflict.batchId}</small><p>{conflict.fieldValue || '（空）'}</p></div>
                </div>
                {conflict.status === 'pending' ? (
                  <div class="conflict-actions">
                    <button class="button small" onClick$={() => resolveConflict(conflict.id, 'master')}>采用馆内主档</button>
                    <button class="button small confirm" onClick$={() => resolveConflict(conflict.id, 'field')}>采用现场批次</button>
                  </div>
                ) : (
                  <p class="resolved-note">{conflict.resolvedAt ? new Date(conflict.resolvedAt).toLocaleString('zh-CN') : ''} 裁决，事实来源：{conflict.resolution === 'field' ? `现场批次 ${conflict.batchId}` : '馆内主档'}</p>
                )}
              </article>
            ))}
            {!state.conflicts.length && (
              <div class="empty-state">暂无字段冲突。两边都改过的字段会并列保留在这里并标出基线原值，人工选定事实来源前，相关匹配的确认与合并都会被挡住。</div>
            )}
          </div>
        </section>
      </section>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}</strong><p>{entry.detail}</p></div><span><em>{entry.source ?? '馆内主档'}</em>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>匹配合并与保护规则</h3></div></div>
          <p>标题、日期、人物、地点和编号按权重综合评分。低于 68% 的候选会以红色标记，但系统不会替研究者自动决定。</p>
          <div class="rule-row"><span>1</span><p>修订包按记录编号三方合并：只有单边改过的字段直接采纳，并写清来源。</p></div>
          <div class="rule-row"><span>2</span><p>两边都改过的字段并列保留、标出基线原值，人工选定事实来源前挡住确认与合并。</p></div>
          <div class="rule-row"><span>3</span><p>馆内主档与现场批次互不覆盖；导入分批处理，中断后进度、失败包与回滚点留在工作区。</p></div>
          <div class="rule-row"><span>4</span><p>记录索引、匹配队列、冲突说明、审计轨迹与导出包都标注修订来源。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">支持 JSON 数组或制表符 / 竖线分隔文本。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importText.value && <div class="file-name">已读取：{importText.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!importRaw.value.trim()} onClick$={parseImport}>导入并重新匹配</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={pkgOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">REVISION PACKAGE</span><Modal.Title>导入现场批次修订包</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">
            修订包为 JSON 对象：{`{"batchId":"FIELD-251005","baselineRevision":3,"edits":[{"identifier":"OH-LXZ-2019-01","changes":{"rights":"家属授权"},"baseValues":{"rights":"研究者授权"}}]}`}。baselineRevision 是批次离场时的主档基线号；导入时按记录编号三方合并，单边改直接采纳，双边改并列保留待裁决，主档与现场批次互不覆盖。
          </Modal.Description>
          <div class="import-controls">
            <label class="file-button">选择修订包文件<input type="file" accept=".json,.txt" onChange$={(event, element) => pkgFile(event, element)} /></label>
            <button class="button small ghost" onClick$={loadSamplePackage}>载入示例修订包</button>
          </div>
          <textarea class="modal-textarea" value={pkgRaw.value} onInput$={(event) => pkgRaw.value = (event.target as HTMLTextAreaElement).value} placeholder='{"batchId":"FIELD-251005","baselineRevision":3,"edits":[{"identifier":"OH-LXZ-2019-01","changes":{"rights":"家属授权"},"baseValues":{"rights":"研究者授权"}}]}' />
          {pkgFileName.value && <div class="file-name">已读取：{pkgFileName.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!pkgRaw.value.trim()} onClick$={importRevisionPackage}>校验并分批导入</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE</span><Modal.Title>逐字段选择保留来源</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {activeMatch.value && (() => {
            const left = recordById(state, activeMatch.value!.leftId)!;
            const right = recordById(state, activeMatch.value!.rightId)!;
            return <>
              <Modal.Description class="modal-description">每个字段都显示两条记录的原始来源。选择后，生成一条新合并记录，原记录编号与选择依据仍保留在审计轨迹中。</Modal.Description>
              <div class="field-picker-head"><span>字段</span><span>A 组来源</span><span>B 组来源</span></div>
              <div class="field-picker">
                {fieldLabels.map(([field, label]) => {
                  const leftValue = fieldValue(left, field) || '—';
                  const rightValue = fieldValue(right, field) || '—';
                  const same = leftValue === rightValue;
                  return <div class={`field-picker-row ${same ? 'same' : 'conflict'}`} key={field}><div class="picker-label"><strong>{label}</strong>{same ? <small>一致</small> : <small>冲突</small>}</div><label class={`source-option ${choices[field] === 'A' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'A'} onChange$={() => choices[field] = 'A'} /><span><b>A</b>{leftValue}</span></label><label class={`source-option ${choices[field] === 'B' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'B'} onChange$={() => choices[field] = 'B'} /><span><b>B</b>{rightValue}</span></label><button class={`combine-button ${choices[field] === 'combine' ? 'selected' : ''}`} onClick$={() => choices[field] = 'combine'} title="拼接两侧内容">拼接</button></div>;
                })}
              </div>
              <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" onClick$={mergeCurrent}>生成合并记录</button></Modal.Footer>
            </>;
          })()}
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
