import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type {
  ArchiveRecord, ArchiveState, FieldKey, FieldBatch, MatchCandidate, MergeJob,
  RecordGroup, RevisionSource
} from './types';
import { computeMatches, fieldValue } from './utils/matching';
import {
  IMPORT_CHUNK, applyFieldEdit, buildRevisionPackage, fieldKeys, parseRevisionPackage,
  restoreSnapshot, snapshotFields, takeSnapshot, writeField
} from './utils/offlineMerge';
import { seedState } from './data/seed';

const STORAGE_KEY = 'sologsb-1020-archive-state-v1';
const JOBS_KEY = 'sologsb-1020-merge-jobs-v1';
const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];
const fieldLabelOf = (field: FieldKey) => fieldLabels.find(([key]) => key === field)?.[1] ?? field;

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const sourceLabel = (source: RevisionSource) => source === 'master' ? '主档' : source === 'field' ? '现场' : '系统';
const sleep = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);
const matchLabel = (state: ArchiveState, match: MatchCandidate) => {
  const left = recordById(state, match.leftId);
  const right = recordById(state, match.rightId);
  return `${left?.title ?? '未知记录'} ↔ ${right?.title ?? '未知记录'}`;
};

export default component$(() => {
  const state = useStore<ArchiveState>(seedState());
  const jobStore = useStore<{ list: MergeJob[] }>({ list: [] });
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | 'suggested' | 'confirmed' | 'rejected'>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const importBusy = useSignal(false);
  const importProgress = useSignal(0);
  const importTotal = useSignal(0);
  const toast = useSignal('');
  const panelTab = useSignal(0);
  const batchName = useSignal('');
  const batchEditOpen = useSignal(false);
  const editTargetKey = useSignal('');
  const newRecordKey = useSignal('');
  const pkgOpen = useSignal(false);
  const pkgRaw = useSignal('');
  const pkgName = useSignal('');
  /** 正在执行的导入任务 id，防止并发重入 */
  const runningJobId = useSignal('');

  const editForm = useStore<Record<FieldKey, string>>({
    title: '', date: '', people: '', places: '', identifier: '', medium: '', extent: '', rights: '', notes: ''
  });

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit,
    conflicts: state.conflicts,
    batches: state.batches,
    activeBatchId: state.activeBatchId
  });

  const capture = () => {
    history.value = [...history.value.slice(-49), snapshot()];
    future.value = [];
  };

  const restore = (raw: string) => {
    const next = JSON.parse(raw) as Partial<ArchiveState>;
    state.revision = next.revision ?? state.revision;
    state.records = (next.records ?? state.records).map((record) => ({ ...record, origin: record.origin ?? 'master', revision: record.revision ?? 1 }));
    state.matches = next.matches ?? state.matches;
    state.merges = next.merges ?? state.merges;
    state.audit = (next.audit ?? state.audit).map((entry) => ({ ...entry, source: entry.source ?? 'system' }));
    state.conflicts = next.conflicts ?? [];
    state.batches = next.batches ?? [];
    state.activeBatchId = next.activeBatchId ?? '';
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 2800);
  };

  const commit = (action: string, detail: string, recordIds: string[] = [], source: RevisionSource = 'system') => {
    state.revision += 1;
    state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail, recordIds, source });
    state.audit = state.audit.slice(0, 300);
  };

  const persistJobs = () => {
    try { localStorage.setItem(JOBS_KEY, JSON.stringify(jobStore.list)); } catch { /* 存储满时保留内存态 */ }
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
  const activeBatch = useComputed$(() => state.batches.find((batch) => batch.id === state.activeBatchId));
  const pendingConflicts = useComputed$(() => state.conflicts.filter((conflict) => conflict.status === 'pending'));
  const resolvedConflicts = useComputed$(() => state.conflicts.filter((conflict) => conflict.status === 'resolved'));
  /** 存在未裁决冲突的记录编号：这些记录的确认与合并一律挡住 */
  const blockedKeys = useComputed$(() => new Set(pendingConflicts.value.map((conflict) => conflict.recordKey)));
  const matchBlocked = (match: MatchCandidate) => {
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    return Boolean((left && blockedKeys.value.has(left.identifier)) || (right && blockedKeys.value.has(right.identifier)));
  };

  const updateMatch = $((id: string, status: MatchCandidate['status']) => {
    const match = state.matches.find((item) => item.id === id);
    if (!match) return;
    if ((status === 'confirmed' || status === 'merged') && matchBlocked(match)) {
      notify('该匹配涉及的记录有未裁决的修订冲突，请先在离线合并台选定事实来源');
      return;
    }
    capture();
    match.status = status;
    match.reviewedAt = new Date().toISOString();
    state.records.forEach((record) => {
      if ((record.id === match.leftId || record.id === match.rightId) && status === 'confirmed') record.status = 'confirmed';
    });
    commit(status === 'confirmed' ? '确认匹配' : '忽略可疑匹配', matchLabel(state, match), [match.leftId, match.rightId], 'master');
    notify(status === 'confirmed' ? '已确认此项匹配' : '已忽略此项匹配');
  });

  const bulkMatch = $((status: MatchCandidate['status']) => {
    const ids = selectedMatchIds.value;
    if (!ids.length) return;
    const guarded = status === 'confirmed' || status === 'merged';
    const blocked = guarded ? ids.filter((id) => {
      const match = state.matches.find((item) => item.id === id);
      return match ? matchBlocked(match) : false;
    }) : [];
    const allowed = ids.filter((id) => !blocked.includes(id));
    if (!allowed.length) {
      notify('所选匹配全部涉及未裁决冲突，已阻止批量操作');
      return;
    }
    capture();
    allowed.forEach((id) => {
      const match = state.matches.find((item) => item.id === id);
      if (!match) return;
      match.status = status;
      match.reviewedAt = new Date().toISOString();
    });
    commit('批量复核', `${allowed.length} 条匹配被标记为${status === 'confirmed' ? '确认' : '忽略'}${blocked.length ? `，${blocked.length} 条因未裁决冲突被跳过` : ''}`, allowed.flatMap((id) => {
      const match = state.matches.find((item) => item.id === id);
      return match ? [match.leftId, match.rightId] : [];
    }), 'master');
    selectedMatchIds.value = [];
    notify(`已批量处理 ${allowed.length} 条匹配${blocked.length ? `，${blocked.length} 条冲突锁定被跳过` : ''}`);
  });

  const openMerge = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    if (matchBlocked(match)) {
      notify('该匹配涉及的记录有未裁决的修订冲突，裁决前不能合并');
      return;
    }
    state.activeMatchId = match.id;
    fieldLabels.forEach(([field]) => {
      const left = recordById(state, match.leftId);
      const right = recordById(state, match.rightId);
      if (left && right && fieldValue(left, field) === fieldValue(right, field)) choices[field] = 'A';
      else choices[field] = 'A';
    });
    mergeOpen.value = true;
  });

  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });

  const mergeCurrent = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    if (matchBlocked(match)) {
      notify('该匹配涉及的记录有未裁决的修订冲突，裁决前不能合并');
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
      revision: state.revision + 1
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
    commit('合并两条记录', `保留 ${Object.values(choices).filter((choice) => choice === 'A').length} 个 A 来源字段、${Object.values(choices).filter((choice) => choice === 'B').length} 个 B 来源字段`, [left.id, right.id, merged.id], 'master');
    mergeOpen.value = false;
    notify('记录已合并，来源与字段选择已写入审计记录');
  });

  const parseImport = $(async () => {
    const raw = importRaw.value.trim();
    if (!raw || importBusy.value) return;
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
    importBusy.value = true;
    importTotal.value = rows.length;
    importProgress.value = 0;
    const CHUNK = 100;
    for (let offset = 0; offset < rows.length; offset += CHUNK) {
      rows.slice(offset, offset + CHUNK).forEach((row) => {
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
          origin: 'master',
          revision: state.revision
        };
        state.records.push(record);
      });
      importProgress.value = Math.min(rows.length, offset + CHUNK);
      if (offset + CHUNK < rows.length) await sleep(20);
    }
    state.matches = computeMatches(state.records);
    commit('导入档案记录', `从 ${importGroup.value} 组分批导入 ${rows.length} 条记录`, [], 'master');
    importBusy.value = false;
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

  /* ---------- 现场批次 ---------- */

  const startBatch = $(() => {
    if (activeBatch.value) {
      notify('已有进行中的现场批次，请先结束或导出');
      return;
    }
    const name = batchName.value.trim() || `现场批次 ${state.batches.length + 1}`;
    capture();
    const batch: FieldBatch = {
      id: crypto.randomUUID(),
      name,
      baselineRevision: state.revision,
      createdAt: new Date().toISOString(),
      edits: []
    };
    state.batches.unshift(batch);
    state.activeBatchId = batch.id;
    commit('开始现场批次', `「${name}」记录主档基线 r${batch.baselineRevision}`, [], 'field');
    batchName.value = '';
    notify(`批次「${name}」已建立，主档基线 r${batch.baselineRevision}`);
  });

  const endBatch = $(() => {
    const batch = activeBatch.value;
    if (!batch) return;
    capture();
    state.activeBatchId = '';
    commit('结束现场批次', `「${batch.name}」停止录改，已保留 ${batch.edits.length} 条改稿`, [], 'field');
    notify('批次已结束，改稿仍保留在批次记录中');
  });

  const openBatchEdit = $(() => {
    if (!activeBatch.value) return;
    editTargetKey.value = '';
    newRecordKey.value = '';
    fieldKeys.forEach((field) => { editForm[field] = ''; });
    batchEditOpen.value = true;
  });

  const prefillEditForm = $((key: string) => {
    editTargetKey.value = key;
    const batch = activeBatch.value;
    if (!batch) return;
    fieldKeys.forEach((field) => { editForm[field] = ''; });
    if (!key || key === '__new__') return;
    const existing = batch.edits.find((edit) => edit.recordKey === key);
    const master = state.records.find((record) => record.identifier === key && record.origin === 'master')
      ?? state.records.find((record) => record.identifier === key);
    fieldKeys.forEach((field) => {
      editForm[field] = existing?.changed[field] ?? existing?.base[field] ?? (master ? fieldValue(master, field) : '');
    });
  });

  const saveBatchEdit = $(() => {
    const batch = activeBatch.value;
    if (!batch) return;
    const key = editTargetKey.value === '__new__' ? newRecordKey.value.trim() : editTargetKey.value;
    if (!key) {
      notify('请先选择要改稿的记录，或填写新记录编号');
      return;
    }
    const master = state.records.find((record) => record.identifier === key && record.origin === 'master')
      ?? state.records.find((record) => record.identifier === key);
    const existing = batch.edits.find((edit) => edit.recordKey === key);
    const base = existing?.base ?? (master ? snapshotFields(master) : {});
    const changed: Partial<Record<FieldKey, string>> = {};
    fieldKeys.forEach((field) => {
      const value = editForm[field].trim();
      if (value !== (base[field] ?? '')) changed[field] = value;
    });
    if (!Object.keys(changed).length) {
      notify('改稿与基线一致，没有需要记录的改动');
      return;
    }
    capture();
    if (existing) existing.changed = changed;
    else batch.edits.push({ recordKey: key, isNew: !master, base, changed });
    commit('现场改稿', `批次「${batch.name}」记录 ${key} 改动 ${Object.keys(changed).length} 个字段`, master ? [master.id] : [], 'field');
    batchEditOpen.value = false;
    notify(`改稿已记入批次「${batch.name}」`);
  });

  const removeBatchEdit = $((recordKey: string) => {
    const batch = activeBatch.value;
    if (!batch) return;
    capture();
    batch.edits = batch.edits.filter((edit) => edit.recordKey !== recordKey);
    commit('撤销现场改稿', `批次「${batch.name}」移除记录 ${recordKey} 的改稿`, [], 'field');
  });

  const exportBatch = $(() => {
    const batch = activeBatch.value;
    if (!batch || !batch.edits.length) return;
    batch.exportedAt = new Date().toISOString();
    const pkg = buildRevisionPackage(batch);
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `修订包-${batch.name}-基线r${batch.baselineRevision}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    commit('导出现场修订包', `批次「${batch.name}」导出 ${batch.edits.length} 条改稿（基线 r${batch.baselineRevision}）`, [], 'field');
    notify('修订包已导出，可带回馆内导入');
  });

  /* ---------- 修订包导入任务（分批处理 + 断点续作 + 回滚） ---------- */

  const runJob = $(async (jobId: string) => {
    const job = jobStore.list.find((item) => item.id === jobId);
    if (!job || job.status === 'done') return;
    if (runningJobId.value) {
      notify('已有导入任务在进行，请等其完成或中断后再试');
      return;
    }
    let pkg;
    try {
      pkg = parseRevisionPackage(job.packageRaw);
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = new Date().toISOString();
      persistJobs();
      notify('修订包无法解析，已保留失败包供修正后重试');
      return;
    }
    if (job.processed === 0) capture();
    runningJobId.value = jobId;
    job.status = 'running';
    job.error = undefined;
    job.updatedAt = new Date().toISOString();
    persistJobs();
    const affected = new Set<string>();
    let newRecords = 0;
    try {
      while (job.processed < pkg.edits.length) {
        const edit = pkg.edits[job.processed];
        const outcome = applyFieldEdit(state, edit, pkg.batchName);
        if (outcome.recordId) affected.add(outcome.recordId);
        if (outcome.kind === 'new-record') newRecords += 1;
        job.processed += 1;
        if (job.processed % IMPORT_CHUNK === 0) {
          job.updatedAt = new Date().toISOString();
          persistJobs();
          await sleep(30);
        }
      }
      state.matches = computeMatches(state.records);
      commit(
        '导入修订包',
        `批次「${pkg.batchName}」（基线 r${pkg.baselineRevision}）分批处理 ${pkg.edits.length} 条改稿：单边改动直接采纳，双边冲突 ${state.conflicts.filter((item) => item.status === 'pending').length} 条待裁决${newRecords ? `，新增现场记录 ${newRecords} 条` : ''}`,
        [...affected],
        'field'
      );
      job.status = 'done';
      job.updatedAt = new Date().toISOString();
      persistJobs();
      notify(`修订包导入完成，共处理 ${job.total} 条改稿`);
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = new Date().toISOString();
      persistJobs();
      notify(`导入在 ${job.processed}/${job.total} 处中断，进度与回滚点已保留，可重试`);
    } finally {
      runningJobId.value = '';
    }
  });

  const startPackageImport = $(() => {
    const raw = pkgRaw.value.trim();
    if (!raw) return;
    let pkg;
    try {
      pkg = parseRevisionPackage(raw);
    } catch (error) {
      notify(error instanceof Error ? error.message : '修订包格式不正确');
      return;
    }
    const job: MergeJob = {
      id: crypto.randomUUID(),
      packageName: pkgName.value.trim() || `修订包-${pkg.batchName}`,
      batchName: pkg.batchName,
      baselineRevision: pkg.baselineRevision,
      total: pkg.edits.length,
      processed: 0,
      status: 'running',
      snapshot: takeSnapshot(state),
      packageRaw: raw,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    jobStore.list.unshift(job);
    persistJobs();
    pkgRaw.value = '';
    pkgName.value = '';
    pkgOpen.value = false;
    runJob(job.id);
  });

  const pkgFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    pkgRaw.value = await file.text();
    pkgName.value = file.name;
  });

  const rollbackJob = $((jobId: string) => {
    const job = jobStore.list.find((item) => item.id === jobId);
    if (!job || runningJobId.value === jobId) return;
    capture();
    restoreSnapshot(state, job.snapshot);
    job.status = 'rolledback';
    job.updatedAt = new Date().toISOString();
    persistJobs();
    commit('回滚修订包导入', `「${job.packageName}」已恢复到导入前的工作区（回滚点 ${new Date(job.startedAt).toLocaleString('zh-CN')}）`, [], 'system');
    notify('已回滚到导入前的工作区，修订包仍保留可重新导入');
  });

  const dropJob = $((jobId: string) => {
    if (runningJobId.value === jobId) return;
    jobStore.list = jobStore.list.filter((item) => item.id !== jobId);
    persistJobs();
  });

  /** 回滚后基于当前工作区重新建立回滚点并再次导入 */
  const restartJob = $((jobId: string) => {
    const job = jobStore.list.find((item) => item.id === jobId);
    if (!job || job.status !== 'rolledback' || runningJobId.value) return;
    job.processed = 0;
    job.snapshot = takeSnapshot(state);
    job.status = 'interrupted';
    job.updatedAt = new Date().toISOString();
    persistJobs();
    runJob(job.id);
  });

  /* ---------- 冲突裁决 ---------- */

  const resolveConflict = $((conflictId: string, choice: 'master' | 'field' | 'combine') => {
    const conflict = state.conflicts.find((item) => item.id === conflictId);
    if (!conflict || conflict.status !== 'pending') return;
    capture();
    conflict.status = 'resolved';
    conflict.resolution = choice;
    conflict.resolvedAt = new Date().toISOString();
    const record = recordById(state, conflict.recordId);
    commit(
      '裁决修订冲突',
      `${conflict.recordKey} · ${fieldLabelOf(conflict.field)}：采用${choice === 'master' ? '主档' : choice === 'field' ? '现场改稿' : '双来源拼接'}（基线原值：${conflict.baseValue || '空'}）`,
      record ? [record.id] : [],
      choice === 'field' ? 'field' : 'master'
    );
    if (record && choice !== 'master') {
      const value = choice === 'combine' ? `${conflict.masterValue}；${conflict.fieldValue}` : conflict.fieldValue;
      writeField(record, conflict.field, value);
      record.revision = state.revision;
      record.updatedAt = new Date().toISOString();
    }
    notify('裁决已记录，该字段冲突解除');
  });

  /* ---------- 导出 ---------- */

  const exportAudit = $(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      masterRevision: state.revision,
      records: state.records.map((record) => ({ ...record, source: sourceLabel(record.origin) })),
      matches: state.matches,
      merges: state.merges,
      conflicts: state.conflicts,
      batches: state.batches.map((batch) => ({ ...batch, edits: batch.edits.length })),
      audit: state.audit.map((entry) => ({ ...entry, sourceLabel: sourceLabel(entry.source) }))
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
    try {
      const rawJobs = localStorage.getItem(JOBS_KEY);
      if (rawJobs) {
        const list = JSON.parse(rawJobs) as MergeJob[];
        list.forEach((job) => { if (job.status === 'running') job.status = 'interrupted'; });
        jobStore.list = list;
      }
    } catch {
      localStorage.removeItem(JOBS_KEY);
    }
    state.hydrated = true;
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => snapshot());
    if (state.hydrated) localStorage.setItem(STORAGE_KEY, payload);
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

  const jobStatusLabel = (job: MergeJob) => ({
    running: '分批处理中',
    interrupted: '已中断 · 可续作',
    failed: '失败 · 可重试',
    done: '已完成',
    rolledback: '已回滚'
  })[job.status];

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat"><span class="online-dot" />{state.hydrated ? `离线保存 · 主档 r${state.revision}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button light" onClick$={exportAudit}>导出核对包</button>
        </div>
      </header>

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>逐条确认可疑匹配，保留每个字段的来源选择，并留下可追溯的处理记录。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          <div class="danger"><strong>{conflictCount.value}</strong><span>低分可疑项</span></div>
          <div class="danger"><strong>{pendingConflicts.value.length}</strong><span>待裁决修订冲突</span></div>
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
              const blocked = matchBlocked(match);
              const isActive = () => state.activeMatchId === match.id;
              return (
                <article
                  data-match-id={match.id}
                  class={`match-card ${isActive() ? 'active' : ''}`}
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
                    {blocked && <span class="lock-badge" title="涉及记录存在未裁决的修订冲突">冲突锁定</span>}
                    <span class="record-id">{left?.identifier}</span>
                  </div>
                  <div class="pair-preview">
                    <div><small>A · {left?.origin === 'field' ? `现场 r${left.revision}` : `主档 r${left?.revision ?? 1}`}</small><strong>{left?.title}</strong><span>{parseDate(left?.date ?? '')} · {left?.people.join('、')}</span></div>
                    <i>↔</i>
                    <div><small>B · {right?.origin === 'field' ? `现场 r${right.revision}` : `主档 r${right?.revision ?? 1}`}</small><strong>{right?.title}</strong><span>{parseDate(right?.date ?? '')} · {right?.people.join('、')}</span></div>
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
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号 / 修订</span><span>状态</span></div>
            {filteredRecords.value.map((record) => (
              <div class="table-row" key={record.id}>
                <span class="origin-cell">
                  <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                  <small class={`origin-tag ${record.origin}`}>{record.origin === 'master' ? '主档' : '现场'}</small>
                </span>
                <strong>{record.title}</strong>
                <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                <span><code>{record.identifier}</code><small class="rev-tag">r{record.revision}</small></span>
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
                const blocked = matchBlocked(activeMatch.value!);
                return <>
                  <div class="active-score"><span>{Math.round(activeMatch.value!.score * 100)}</span><div><strong>综合匹配分</strong><small>{activeMatch.value!.reasons.join(' · ')}</small></div></div>
                  {blocked && <div class="block-banner">涉及记录存在未裁决的修订冲突，确认与合并已被挡住。请先在下方「离线合并台」选定事实来源。</div>}
                  <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源（{left?.origin === 'field' ? '现场' : '主档'}）</div><div>B 来源（{right?.origin === 'field' ? '现场' : '主档'}）</div>
                    {fieldLabels.map(([field, label]) => <><div class="field-label">{label}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}</div></>)}
                  </div>
                  <div class="action-stack"><button class="button primary wide" disabled={blocked} onClick$={openMerge}>逐字段合并</button><div class="split-actions"><button class="button confirm" disabled={blocked} onClick$={() => updateMatch(activeMatch.value!.id, 'confirmed')}>确认匹配</button><button class="button ghost" onClick$={() => updateMatch(activeMatch.value!.id, 'rejected')}>忽略</button></div></div>
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

      <section class="panel merge-desk">
        <div class="panel-heading">
          <div><span class="eyebrow">03 / OFFLINE MERGE</span><h3>离线修订合并台</h3></div>
          <span>主档与现场批次互不覆盖 · 中断可续作</span>
        </div>
        <div class="merge-columns">
          <div class="merge-col">
            <span class="eyebrow">FIELD BATCH</span>
            <h4>现场批次</h4>
            {activeBatch.value ? (() => {
              const batch = activeBatch.value!;
              return <>
                <div class="batch-active">
                  <div class="batch-line"><strong>{batch.name}</strong><span class="baseline-tag">基线 r{batch.baselineRevision}</span></div>
                  <p>本地改稿 {batch.edits.length} 条 · 主档当前 r{state.revision}{batch.exportedAt ? ` · 已于 ${new Date(batch.exportedAt).toLocaleString('zh-CN')} 导出` : ''}</p>
                  <div class="batch-actions">
                    <button class="button small" onClick$={openBatchEdit}>录入改稿</button>
                    <button class="button small light" disabled={!batch.edits.length} onClick$={exportBatch}>导出修订包</button>
                    <button class="button small ghost" onClick$={endBatch}>结束批次</button>
                  </div>
                </div>
                {batch.edits.length ? <ul class="edit-list">
                  {batch.edits.map((edit) => <li key={edit.recordKey}>
                    <code>{edit.recordKey}</code>
                    <span>{edit.isNew ? '新记录 · ' : ''}{Object.keys(edit.changed).map((field) => fieldLabelOf(field as FieldKey)).join('、')}</span>
                    <button class="mini-button" onClick$={() => removeBatchEdit(edit.recordKey)}>移除</button>
                  </li>)}
                </ul> : <p class="col-note">还没有改稿。点击「录入改稿」记录现场修订，基线值会自动取自批次的基线快照。</p>}
              </>;
            })() : <>
              <p class="col-note">出发到现场前建立一个批次，系统会记下当前主档修订号作为基线；现场的所有改稿都挂在批次下，回馆后导出修订包。</p>
              <div class="batch-start">
                <input class="input" placeholder="批次名称，如：河口村秋季审校" value={batchName.value} onInput$={(event) => batchName.value = (event.target as HTMLInputElement).value} />
                <button class="button small" onClick$={startBatch}>开始现场批次（基线 r{state.revision}）</button>
              </div>
            </>}
            {state.batches.length > 0 && <div class="batch-history">
              <span class="eyebrow">历史批次</span>
              {state.batches.slice(0, 4).map((batch) => <div class="batch-history-row" key={batch.id}><strong>{batch.name}</strong><span>基线 r{batch.baselineRevision} · 改稿 {batch.edits.length} 条{batch.exportedAt ? ' · 已导出' : ''}</span></div>)}
            </div>}
          </div>

          <div class="merge-col">
            <span class="eyebrow">PACKAGE IMPORT</span>
            <h4>修订包导入</h4>
            <p class="col-note">按记录编号做三方合并：单边改动直接采纳，双边改动并列保留并挡住确认 / 合并。大批量分批处理，中断后进度与回滚点留在工作区。</p>
            <button class="button small" onClick$={() => pkgOpen.value = true}>导入修订包</button>
            <div class="job-list">
              {jobStore.list.map((job) => {
                const pct = job.total ? Math.round((job.processed / job.total) * 100) : 0;
                return <div class={`job-card ${job.status}`} key={job.id}>
                  <div class="job-head"><strong>{job.packageName}</strong><span>批次「{job.batchName}」 · 基线 r{job.baselineRevision}</span></div>
                  <div class="progress"><i style={{ width: `${pct}%` }} /></div>
                  <div class="job-meta"><span>{job.processed}/{job.total} 条 · {jobStatusLabel(job)}</span><span>{new Date(job.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></div>
                  {job.error && <p class="job-error">{job.error}</p>}
                  <div class="job-actions">
                    {(job.status === 'interrupted' || job.status === 'failed') && <button class="button small" onClick$={() => runJob(job.id)}>继续导入</button>}
                    {job.status === 'rolledback' && <button class="button small" onClick$={() => restartJob(job.id)}>重新导入</button>}
                    {job.status !== 'rolledback' && <button class="button small ghost" onClick$={() => rollbackJob(job.id)}>回滚到导入前</button>}
                    <button class="mini-button" onClick$={() => dropJob(job.id)}>清除记录</button>
                  </div>
                </div>;
              })}
              {!jobStore.list.length && <p class="col-note">暂无导入任务。失败或中断的任务会连同样包、进度和回滚点留在这里。</p>}
            </div>
          </div>

          <div class="merge-col">
            <span class="eyebrow">CONFLICTS</span>
            <h4>冲突裁决 <em class="count-chip">{pendingConflicts.value.length} 待裁决</em></h4>
            <div class="conflict-list">
              {pendingConflicts.value.map((conflict) => <div class="conflict-card" key={conflict.id}>
                <div class="conflict-head"><strong>{conflict.recordKey} · {fieldLabelOf(conflict.field)}</strong><span>来自批次「{conflict.batchName}」</span></div>
                <div class="conflict-values">
                  <div><small>基线原值</small><p>{conflict.baseValue || '—'}</p></div>
                  <div><small>主档现值</small><p>{conflict.masterValue || '—'}</p></div>
                  <div><small>现场改稿</small><p>{conflict.fieldValue || '—'}</p></div>
                </div>
                <div class="conflict-actions">
                  <button class="button small ghost" onClick$={() => resolveConflict(conflict.id, 'master')}>取主档</button>
                  <button class="button small" onClick$={() => resolveConflict(conflict.id, 'field')}>取现场</button>
                  <button class="button small light" onClick$={() => resolveConflict(conflict.id, 'combine')}>拼接保留</button>
                </div>
              </div>)}
              {!pendingConflicts.value.length && <p class="col-note">没有待裁决的冲突。两边都改过的字段会并列保留在这里，选定事实来源前相关记录的确认与合并会被挡住。</p>}
              {resolvedConflicts.value.length > 0 && <p class="col-note">已裁决 {resolvedConflicts.value.length} 条，裁决来源见审计轨迹。</p>}
            </div>
          </div>
        </div>
      </section>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">04 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}<em class={`src ${entry.source}`}>{sourceLabel(entry.source)}</em></strong><p>{entry.detail}</p></div><span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>匹配合并与保护规则</h3></div></div>
          <p>标题、日期、人物、地点和编号按权重综合评分。低于 68% 的候选会以红色标记，但系统不会替研究者自动决定。</p>
          <div class="rule-row"><span>1</span><p>修订包按记录编号三方合并：只有一边改过的字段直接采纳，主档与现场批次互不覆盖。</p></div>
          <div class="rule-row"><span>2</span><p>两边都改过的字段并列保留并标出基线原值，裁决前挡住相关记录的确认与合并。</p></div>
          <div class="rule-row"><span>3</span><p>导入分批处理；失败包、进度与回滚点留在工作区，断网或中断后可续作。</p></div>
          <div class="rule-row"><span>4</span><p>记录索引、匹配队列、冲突说明、审计轨迹与导出包均标注修订来源。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">支持 JSON 数组或制表符 / 竖线分隔文本。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。大批量将分批写入。</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importText.value && <div class="file-name">已读取：{importText.value}</div>}
          <Modal.Footer class="modal-footer">
            {importBusy.value && <span class="import-progress">分批写入 {importProgress.value}/{importTotal.value}</span>}
            <Modal.Close class="button ghost">取消</Modal.Close>
            <button class="button primary" disabled={!importRaw.value.trim() || importBusy.value} onClick$={parseImport}>{importBusy.value ? '正在分批导入…' : '导入并重新匹配'}</button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={batchEditOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD EDIT</span><Modal.Title>录入现场改稿</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">改稿挂在当前批次「{activeBatch.value?.name}」下（基线 r{activeBatch.value?.baselineRevision}）。只记录与基线不同的字段，主档不会被改动。</Modal.Description>
          <div class="batch-edit-form">
            <label class="form-row"><span>记录</span>
              <select class="input" value={editTargetKey.value} onChange$={(event) => prefillEditForm((event.target as HTMLSelectElement).value)}>
                <option value="">选择要改稿的记录…</option>
                {state.records.filter((record) => record.origin === 'master').map((record) => <option key={record.id} value={record.identifier}>{`${record.identifier} · ${record.title}`}</option>)}
                <option value="__new__">＋ 新记录（主档暂无此编号）</option>
              </select>
            </label>
            {editTargetKey.value === '__new__' && <label class="form-row"><span>新记录编号</span><input class="input" placeholder="如 OH-2026-101" value={newRecordKey.value} onInput$={(event) => newRecordKey.value = (event.target as HTMLInputElement).value} /></label>}
            {editTargetKey.value && fieldLabels.filter(([field]) => field !== 'identifier').map(([field, label]) => (
              <label class="form-row" key={field}>
                <span>{label}</span>
                <input class="input" value={editForm[field]} onInput$={(event) => { editForm[field] = (event.target as HTMLInputElement).value; }} />
              </label>
            ))}
          </div>
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!editTargetKey.value} onClick$={saveBatchEdit}>保存改稿到批次</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={pkgOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">REVISION PACKAGE</span><Modal.Title>导入现场修订包</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">粘贴或选择现场批次导出的修订包 JSON。导入按记录编号三方合并并分批处理；中断或失败时，样包、进度与回滚点会留在工作区供重试。</Modal.Description>
          <div class="import-controls">
            <label class="file-button">选择修订包文件<input type="file" accept=".json" onChange$={(event, element) => pkgFile(event, element)} /></label>
            {pkgName.value && <span class="file-name">已读取：{pkgName.value}</span>}
          </div>
          <textarea class="modal-textarea" value={pkgRaw.value} onInput$={(event) => pkgRaw.value = (event.target as HTMLTextAreaElement).value} placeholder='{"format":"sologsb-revision-package","batchName":"河口村秋季审校","baselineRevision":12,"edits":[...]}' />
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!pkgRaw.value.trim()} onClick$={startPackageImport}>校验并开始分批导入</button></Modal.Footer>
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
              <div class="field-picker-head"><span>字段</span><span>A 组来源（{left?.origin === 'field' ? '现场' : '主档'}）</span><span>B 组来源（{right?.origin === 'field' ? '现场' : '主档'}）</span></div>
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
