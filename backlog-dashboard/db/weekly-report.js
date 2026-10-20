'use strict';

// 週報(BT-291)。task_events(履歴)とtasks(期日・現在のステータス)の両方を見て、期間内にやったこと・
// 期日が絡むタスクをワークスペース単位のMarkdown表にする。読み取りのみ。
// 日付はすべてJST基準(csv-export.jsと同じ)。
//
// BM-121: EPIC(子タスクを持つ親)は週報では1行に集約する。子タスクを個別行として並べるのはやめ、
// EPIC単位で区分・期日・担当者等を集約した1行として出す(単発タスクは従来どおり1件=1行)。
// カテゴリはEPIC/単発のみが意味を持つ属性として扱い、子タスク自身のcategory列は週報では参照しない。

const fs = require('node:fs');
const path = require('node:path');
const tagsRepo = require('./tags-repo');
const externalLinksRepo = require('./external-links-repo');
const categoriesRepo = require('./categories-repo');

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 表に出せる列。idとtitleは必須(外せない)。
const COLUMN_DEFS = [
  { key: 'id', label: 'ID', required: true },
  { key: 'title', label: '件名', required: true },
  { key: 'kind', label: '区分' },
  { key: 'status', label: 'ステータス' },
  { key: 'updatedAt', label: '最終ステータス更新' },
  { key: 'dueDate', label: '期日' },
  { key: 'assignee', label: '担当' },
  { key: 'tags', label: 'タグ' },
  { key: 'commit', label: 'コミット' },
  { key: 'issue', label: 'GitHub Issue' },
  { key: 'external', label: '外部ITS Issue' }, // Redmine/GitLab(BT-438)
];
const DEFAULT_COLUMNS = ['id', 'title', 'kind', 'status', 'updatedAt', 'dueDate'];

const DEFAULT_TEMPLATE = `# 週報 {{period}}

出力ステータス: {{statuses}} / 作成: {{generatedAt}}

{{#workspace}}
## {{workspaceId}} {{workspaceName}} {{statusCounts}}

{{summary}}

{{table}}

{{/workspace}}
`;

// 画面のプレースホルダー説明にも使う(name, 使える場所, 説明, 例)
const PLACEHOLDERS = [
  { name: 'period', scope: '全体', description: '集計期間(開始〜終了)', example: '2026-10-12（月） 〜 2026-10-18（日）' },
  { name: 'from', scope: '全体', description: '期間の開始日', example: '2026-10-12' },
  { name: 'to', scope: '全体', description: '期間の終了日', example: '2026-10-18' },
  { name: 'statuses', scope: '全体', description: '出力対象に選んだステータス', example: 'DONE / DO' },
  { name: 'generatedAt', scope: '全体', description: '週報を作った日時', example: '2026-10-18 20:30' },
  { name: 'totalCount', scope: '全体', description: '出力したタスクの総数', example: '12' },
  { name: '#workspace … /workspace', scope: '全体', description: 'この囲みの中身を、対象ワークスペースごとに繰り返す', example: '{{#workspace}}…{{/workspace}}' },
  { name: 'workspaceId', scope: 'ワークスペースの囲み内', description: 'ワークスペースのプレフィクス', example: 'BT' },
  { name: 'workspaceName', scope: 'ワークスペースの囲み内', description: 'ワークスペース名', example: 'backlog-todo' },
  { name: 'workspaceFile', scope: 'ワークスペースの囲み内', description: 'ワークスペースの識別子(projects[].file)', example: 'backlog-todo' },
  { name: 'statusCounts', scope: 'ワークスペースの囲み内', description: 'ステータス別の件数バッジ(TODO/READY/DO/DONE)。出力ステータスの選択に関わらず4つとも数える。期間内にそのステータスへ変わった(TODOは新規作成を含む)タスクがある数字は太字', example: '`TODO 3` `READY 2` **`DO 1`** `DONE 5`' },
  { name: 'summary', scope: 'ワークスペースの囲み内', description: '件数のまとめ(完了/対応中/期限超過/未着手)', example: '完了 3件 / 対応中 2件 / 期限超過 1件' },
  { name: 'doneCount', scope: 'ワークスペースの囲み内', description: '完了の件数', example: '3' },
  { name: 'doingCount', scope: 'ワークスペースの囲み内', description: '対応中(DO/READY)の件数', example: '2' },
  { name: 'overdueCount', scope: 'ワークスペースの囲み内', description: '期限超過(未完了で期日が今日より前)の件数', example: '1' },
  { name: 'count', scope: 'ワークスペースの囲み内', description: 'このワークスペースの出力件数', example: '6' },
  { name: 'table', scope: 'ワークスペースの囲み内', description: 'タスクの表。期限超過 → 完了 → 対応中(DO/READY) → 未着手(TODO)の順に見出しを分け、該当が無い見出しは出さない(カテゴリで章を分けている時は、章の中では見出しを分けず1つの表にする。BM-121)。EPIC(子タスクを持つ親)はヒットした子タスクをまとめて1行にし、件名の下に子タスクの件名を小さく列挙する(BM-121)', example: '(表)' },
];

function jstParts(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  return d.toISOString(); // 先頭がJSTの壁時計
}

function toJstDate(value) {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? '' : jstParts(ms).slice(0, 10);
}

function toJstDateTime(value) {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? '' : jstParts(ms).slice(0, 16).replace('T', ' ');
}

function todayJst() {
  return jstParts(Date.now()).slice(0, 10);
}

// JSTの日付文字列(YYYY-MM-DD)にn日足す
function addDays(dateStr, n) {
  const ms = Date.parse(`${dateStr}T00:00:00Z`) + n * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// YYYY-MM-DD → YYYY-MM-DD（曜）
function withDow(dateStr) {
  return `${dateStr}（${'日月火水木金土'[new Date(`${dateStr}T00:00:00Z`).getUTCDay()]}）`;
}

/**
 * 「今週」「先週」の期間(月曜〜日曜、JST)。
 * @param {'this'|'last'} which
 * @param {string} [today] YYYY-MM-DD(テスト用)
 */
function weekRange(which, today = todayJst()) {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0=日
  const monday = addDays(today, -((dow + 6) % 7) - (which === 'last' ? 7 : 0));
  return { from: monday, to: addDays(monday, 6) };
}

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function normalizeColumns(columns) {
  const known = new Set(COLUMN_DEFS.map(c => c.key));
  const picked = Array.isArray(columns) ? columns.filter((k, i) => known.has(k) && columns.indexOf(k) === i) : [];
  const list = picked.length ? picked : DEFAULT_COLUMNS.slice();
  for (const required of ['title', 'id']) {
    if (!list.includes(required)) list.unshift(required);
  }
  return list;
}

// 表示ラベルは画面と同じ英語表記(BT-178)。DBのstatuses.labelは日本語なので使わない
const STATUS_LABEL = { todo: 'TODO', ready: 'READY', do: 'DO', done: 'DONE' };
const STATUS_CODES = ['todo', 'ready', 'do', 'done'];

// 週報でのカテゴリ名。未設定は''。旧データのプレースホルダー'-'もカテゴリなしとして扱う
function categoryOf(row) {
  return row.category && row.category !== '-' ? row.category : '';
}

// タスク1件分の実効カテゴリ。子タスクは親(EPIC)のカテゴリを使う
// (BM-121: カテゴリはEPIC/単発のみが意味を持つ属性。子自身のcategory列は週報では見ない)
function effectiveCategory(row, byId) {
  if (row.parent_id === null) return categoryOf(row);
  const parent = byId.get(row.parent_id);
  return parent ? categoryOf(parent) : categoryOf(row);
}

// 表の見出しの並び(BT-438)。単発/EPICの区分けはせず、区分ごとに1つの表にする。
const SECTIONS = [
  { kind: '期限超過', heading: '期限超過' },
  { kind: '完了', heading: '完了（DONE）' },
  { kind: '対応中', heading: '対応中（DO/READY）' },
  { kind: '未着手', heading: '未着手（TODO）' },
];
const KIND_PRIORITY = SECTIONS.map(s => s.kind); // 見出しを分けない表(カテゴリ章)での並び順に使う(BM-121)

// カテゴリ章のように見出しを分けない1枚の表で使う並び順。
// 区分(期限超過→完了→対応中→未着手)を優先し、同じ区分内は更新が新しい順(toSections内のsortと同じ基準)。
function sortByKindPriority(items) {
  return [...items].sort((a, b) => {
    const diff = KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind);
    return diff !== 0 ? diff : (a.updatedAtRaw < b.updatedAtRaw ? 1 : -1);
  });
}

/**
 * ワークスペース1つ分の、週報の元になる集計素材を読む(論理削除済みは除く)。
 *  movedTo: task_id -> 期間内に変わったステータスの集合 / lastChange: task_id -> 最終のステータス変更日時(全期間)
 *  candidates: EPIC自身(子を持つ親)を除いた、単発+子のみの行。EPIC行の採否はcollectWeeklyReport側で
 *  「ヒットした子が1件以上あるか」から決めるため、ここではEPIC自身のpickIncluded判定は行わない(BM-121)。
 */
function analyzeWorkspace(db, project, from, to) {
  const rows = db.prepare('SELECT * FROM tasks WHERE workspace = ? AND deleted_at IS NULL ORDER BY sort_order').all(project.file);
  const byId = new Map(rows.map(r => [r.id, r]));
  const childIds = new Set();
  for (const r of rows) {
    if (r.parent_id !== null && byId.has(r.parent_id)) childIds.add(r.parent_id);
  }

  const lastChange = new Map();
  const movedTo = new Map();
  const events = db.prepare(`
    SELECT te.task_id, te.new_value, te.occurred_at
    FROM task_events te JOIN tasks t ON t.id = te.task_id
    WHERE t.workspace = ? AND te.event_type = 'status_changed' ORDER BY te.occurred_at, te.id
  `).all(project.file);
  for (const e of events) {
    lastChange.set(e.task_id, e.occurred_at);
    const day = toJstDate(e.occurred_at);
    if (day >= from && day <= to) {
      if (!movedTo.has(e.task_id)) movedTo.set(e.task_id, new Set());
      movedTo.get(e.task_id).add(e.new_value);
    }
  }
  const candidates = rows.filter(r => !childIds.has(r.id)); // EPIC自身は対象にしない
  return { rows, byId, lastChange, movedTo, candidates };
}

/**
 * 週報に出すタスクを選ぶ(単発+子。EPIC自身は対象にしない)。
 *   A) 期間内に、選ばれたステータスへ変わった(task_eventsのstatus_changed)
 *   B) 期日が期間内、または期日が期間より前で未完了(ステータス不問)
 */
function pickIncluded(analysis, selected, from, to) {
  return analysis.candidates.filter(r => {
    const moved = analysis.movedTo.get(r.id);
    if (moved && [...moved].some(s => selected.has(s))) return true;
    if (!r.due_date) return false;
    if (r.due_date >= from && r.due_date <= to) return true;
    return r.due_date < from && r.status !== 'done';
  });
}

/**
 * ステータス別の件数。出力ステータスの選択には依存せず、4ステータスすべてを選んだ前提で対象を選ぶ。
 * active[s]は「現在sのタスクのうち、期間内にsへ変わった(todoは期間内の新規作成を含む)ものがある」か。
 * BM-121のEPIC集約の対象外(単発+子を個別に数える。粒度は従来どおり)。
 */
function statusCountsFor(analysis, from, to) {
  const included = pickIncluded(analysis, new Set(STATUS_CODES), from, to);
  const counts = { todo: 0, ready: 0, do: 0, done: 0 };
  const active = { todo: false, ready: false, do: false, done: false };
  for (const r of included) {
    if (!(r.status in counts)) continue;
    counts[r.status] += 1;
    const created = r.status === 'todo' && toJstDate(r.created_at) >= from && toJstDate(r.created_at) <= to;
    if (created || (analysis.movedTo.get(r.id) || new Set()).has(r.status)) active[r.status] = true;
  }
  return { counts, active };
}

// 子タスクの区分から、EPIC行の区分を決める(BM-121)。
// 優先順位: 期限超過(子に1件でも) > 対応中(子にdo/readyが1件でも) > 未着手(子が全部todo) > 完了(子が全部done)
// いずれにも当てはまらない混在(例: 完了と未着手が同時に残る)は、まだ作業が残っているとみなし対応中として扱う。
function aggregateKind(kinds) {
  if (kinds.includes('期限超過')) return '期限超過';
  if (kinds.includes('対応中')) return '対応中';
  if (kinds.every(k => k === '未着手')) return '未着手';
  if (kinds.every(k => k === '完了')) return '完了';
  return '対応中';
}

// 値の一覧から、空を除き重複を除いて', '区切りで並べる(EPIC行の担当者・タグ・コミット等の集約に使う)
function dedupJoin(list) {
  return [...new Set(list.filter(Boolean))].join(', ');
}

/**
 * EPIC(子タスクを持つ親)1行分のitemを、ヒットした子タスク(leaves)から組み立てる(BM-121)。
 *  - category: EPIC自身のカテゴリ(子のcategoryは見ない)
 *  - kind: aggregateKind()。EPIC自身のstatus/due_dateは見ない(子の状態だけで決める)
 *  - dueDate: ヒットした子の期日のうち最大(最も遅い)日付。子がいくつか集まって目的を達成する構造のため
 *  - assignee/tags/commit/issue/externalLinks: ヒットした子の範囲から重複を除いて列挙
 */
function buildEpicItem(epicRow, leaves) {
  const dueDates = leaves.map(l => l.dueDate).filter(Boolean);
  const dueDate = dueDates.length ? dueDates.reduce((max, d) => (d > max ? d : max)) : '';
  const updatedAtRaw = leaves.reduce((max, l) => (l.updatedAtRaw > max ? l.updatedAtRaw : max), leaves[0].updatedAtRaw);
  const linkMap = new Map();
  for (const l of leaves) for (const link of l.externalLinks) linkMap.set(`${link.source}:${link.key}`, link);
  // GitHub Issueは複数件ありうるので、リンクがあれば子ごとにMarkdownリンク化してから列挙する
  const issueTexts = leaves.map(l => (l.issue ? (l.issueUrl ? `[${l.issue}](${l.issueUrl})` : l.issue) : '')).filter(Boolean);
  return {
    id: epicRow.display_id,
    title: epicRow.title,
    isEpic: true,
    childLeaves: leaves, // 件名セルで「ヒットした子タスク」を列挙するために保持
    status: '',
    statusLabel: dedupJoin(leaves.map(l => l.statusLabel)),
    kind: aggregateKind(leaves.map(l => l.kind)),
    category: categoryOf(epicRow),
    updatedAt: toJstDateTime(updatedAtRaw),
    updatedAtRaw,
    dueDate,
    assignee: dedupJoin(leaves.map(l => l.assignee)),
    tags: dedupJoin(leaves.flatMap(l => (l.tags ? l.tags.split(', ') : []))),
    commit: dedupJoin(leaves.map(l => l.commit)),
    issue: dedupJoin(issueTexts),
    issueUrl: '',
    externalLinks: [...linkMap.values()],
  };
}

/**
 * 週報の元データを集める。対象になるタスクの選び方はpickIncluded()を参照(EPIC自身は含めない)。
 * EPIC(子タスクを持つ親)は、ヒットした子タスクを1行に集約する(BM-121)。単発タスクは1件=1行のまま。
 * @returns {{from, to, today, statuses, workspaces: Array}}
 */
function collectWeeklyReport(db, config, { from, to, workspaces, statuses, today = todayJst(), groupByCategory = false, categories }) {
  const selected = new Set(statuses);
  const categoryFilter = Array.isArray(categories) ? new Set(categories) : null; // ''はカテゴリなし
  const masterOrder = categoriesRepo.listCategories(db).map(c => c.name);

  const projects = (config.projects || []).filter(p => workspaces.includes(p.file));
  const result = [];
  for (const project of projects) {
    const analysis = analyzeWorkspace(db, project, from, to);
    const { byId, lastChange } = analysis;
    const includedRows = pickIncluded(analysis, selected, from, to); // 単発+子のみ(EPIC自身は含まない)

    const tagsByTask = tagsRepo.listTagsForTasks(db, includedRows.map(r => r.id));
    const linksByTask = externalLinksRepo.listLinksForTasks(db, includedRows.map(r => r.id));

    const toLeafItem = r => {
      const overdue = Boolean(r.due_date) && r.status !== 'done' && r.due_date < today;
      let kind;
      if (r.status === 'done') kind = '完了';
      else if (overdue) kind = '期限超過';
      else if (r.status === 'todo') kind = '未着手';
      else kind = '対応中'; // do / ready
      const updated = lastChange.get(r.id) || r.created_at;
      return {
        id: r.display_id,
        title: r.title,
        status: r.status,
        statusLabel: STATUS_LABEL[r.status] || r.status,
        kind,
        updatedAt: toJstDateTime(updated),
        updatedAtRaw: updated,
        dueDate: r.due_date || '',
        assignee: r.assignee || '',
        tags: (tagsByTask[r.id] || []).map(t => t.name).join(', '),
        commit: r.commit_hash ? r.commit_hash.slice(0, 7) : '',
        issue: r.github_issue_number ? `#${r.github_issue_number}` : '',
        issueUrl: r.github_issue_url || '',
        externalLinks: (linksByTask[r.id] || []).map(l => ({ source: l.source, key: l.key, url: l.url })),
      };
    };

    // 単発は1件=1行
    const soloItems = includedRows
      .filter(r => r.parent_id === null)
      .map(r => ({ ...toLeafItem(r), isEpic: false, childLeaves: null, category: categoryOf(r) }));

    // 子はEPIC(親)単位でまとめ、ヒットした子だけを1行に集約する(BM-121)
    const childrenByParent = new Map();
    for (const r of includedRows) {
      if (r.parent_id === null) continue;
      if (!childrenByParent.has(r.parent_id)) childrenByParent.set(r.parent_id, []);
      childrenByParent.get(r.parent_id).push(toLeafItem(r));
    }
    const epicItems = [];
    for (const [parentId, leaves] of childrenByParent) {
      const epicRow = byId.get(parentId);
      if (!epicRow) continue; // 親が見つからない(想定外。子を持つタスクの削除はAPI側で拒否されるため通常発生しない)
      epicItems.push(buildEpicItem(epicRow, leaves));
    }

    const items = [...soloItems, ...epicItems]
      .filter(i => !categoryFilter || categoryFilter.has(i.category))
      .sort((a, b) => (a.updatedAtRaw < b.updatedAtRaw ? 1 : -1));
    const toSections = list => SECTIONS
      .map(s => ({ kind: s.kind, heading: s.heading, items: list.filter(i => i.kind === s.kind) }))
      .filter(s => s.items.length > 0);
    const sections = toSections(items);
    // カテゴリの章: マスタ順 → マスタに無い値(移行前の自由入力)→ カテゴリなし。期間内に該当タスクが無いカテゴリは出さない
    // BM-121: カテゴリで章を分けた場合、章の中でさらにステータス区分の見出しは作らない(カテゴリとステータスは
    // 別軸であり、章の下に見出しを重ねるのは冗長)。1つの表にまとめ、並び順だけ期限超過→完了→対応中→未着手の
    // 優先度を保つ(区分自体は表の「区分」列に出る)。
    let categoryGroups = null;
    if (groupByCategory) {
      const present = [...new Set(items.map(i => i.category).filter(Boolean))];
      const names = [
        ...masterOrder.filter(n => present.includes(n)),
        ...present.filter(n => !masterOrder.includes(n)).sort(),
        ...(items.some(i => !i.category) ? [''] : []),
      ];
      categoryGroups = names.map(name => ({ name, items: sortByKindPriority(items.filter(i => i.category === name)) }));
    }

    result.push({
      file: project.file,
      prefix: project.prefix || '',
      name: project.name || project.file,
      sections,
      categoryGroups, // groupByCategory時のみ [{name('':カテゴリなし), items}](BM-121: ステータス見出しは分けない)
      count: items.length,
      counts: {
        done: items.filter(i => i.kind === '完了').length,
        doing: items.filter(i => i.kind === '対応中').length,
        overdue: items.filter(i => i.kind === '期限超過').length,
        planned: items.filter(i => i.kind === '未着手').length, // 未着手(TODO)
      },
      statusCounts: statusCountsFor(analysis, from, to),
    });
  }
  return { from, to, today, statuses: [...selected].map(c => STATUS_LABEL[c] || c), workspaces: result };
}

/**
 * 画面の対象ワークスペース横に出す、ステータス別の件数(期間のみで決まる)。
 */
function buildWeeklyCounts(db, config, input) {
  const opts = parseReportOptions(input, config, db);
  if (opts.error) return opts;
  const workspaces = (config.projects || []).filter(p => opts.workspaces.includes(p.file)).map(project => {
    const analysis = analyzeWorkspace(db, project, opts.from, opts.to);
    // カテゴリ別の件数(BT-442): 選択ステータスで出力対象になるタスクを数える。''はカテゴリなし
    // BM-121: 子タスクは親(EPIC)のカテゴリとして数える(週報本体のカテゴリ集約と一致させる)
    const categories = {};
    for (const r of pickIncluded(analysis, new Set(opts.statuses), opts.from, opts.to)) {
      const name = effectiveCategory(r, analysis.byId);
      categories[name] = (categories[name] || 0) + 1;
    }
    return { file: project.file, ...statusCountsFor(analysis, opts.from, opts.to), categories };
  });
  return { ok: true, from: opts.from, to: opts.to, workspaces };
}

// Markdownの表セルに入れても崩れないようにする(パイプ・改行)
function cell(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// 件数バッジ(コードスパン風)。動きがあった数字は太字。
function renderStatusCounts({ counts, active }) {
  return STATUS_CODES.map(code => {
    const badge = `\`${STATUS_LABEL[code]} ${counts[code]}\``;
    return active[code] ? `**${badge}**` : badge;
  }).join(' ');
}

const EXTERNAL_SOURCE_LABEL = { redmine: 'Redmine', gitlab: 'GitLab' };

// EPICのタイトル先頭に付ける線画系の記号(BT-450)。貼り先のフォントで表示できない場合はここだけ差し替える。
const EPIC_TITLE_MARK = '⧉';

// 件名セル。EPIC(集約行)はタイトルの先頭に記号を付け、下にヒットした子タスクだけを<small>+<br/>+「└」で列挙する(BM-121)。
// 単発タスクはタイトルだけ。
function renderTitleCell(item) {
  if (!item.isEpic) return cell(item.title);
  const childLines = item.childLeaves.map(c => `└ ${cell(c.title)}`).join('<br/>');
  return `${EPIC_TITLE_MARK} ${cell(item.title)}<br/><small>${childLines}</small>`;
}

function renderExternal(item) {
  return item.externalLinks.map(l => {
    const text = cell(`${EXTERNAL_SOURCE_LABEL[l.source] || l.source} #${l.key}`);
    return l.url ? `[${text}](${l.url})` : text;
  }).join(', ');
}

function renderTable(items, columns) {
  const defs = columns.map(k => COLUMN_DEFS.find(c => c.key === k));
  const header = `| ${defs.map(d => d.label).join(' | ')} |`;
  const sep = `| ${defs.map(() => '---').join(' | ')} |`;
  const lines = items.map(item => {
    const cells = columns.map(k => {
      if (k === 'title') return renderTitleCell(item);
      if (k === 'status') return cell(item.statusLabel);
      if (k === 'issue') return item.issueUrl ? `[${cell(item.issue)}](${item.issueUrl})` : cell(item.issue);
      if (k === 'external') return renderExternal(item);
      if (k === 'dueDate') return item.dueDate ? cell(item.kind === '期限超過' ? `${item.dueDate} ⚠` : item.dueDate) : '';
      return cell(item[k]);
    });
    return `| ${cells.join(' | ')} |`;
  });
  return [header, sep, ...lines].join('\n');
}

const NO_CATEGORY_HEADING = 'なし';
const NO_CATEGORY_TOKEN = '__none__'; // GETのクエリで「カテゴリなし」を表す

function renderWorkspaceTable(ws, columns) {
  if (ws.sections.length === 0) return '(該当するタスクはありません)';
  if (ws.categoryGroups) {
    // カテゴリごとに見出し(###、カテゴリ名そのまま)+表の1枚構成にする(BM-121)。カテゴリとステータスは
    // 別軸のため、見出しの中でさらにステータス区分の見出しには分けない(区分は表の「区分」列に出る)。
    // 箇条書き(字下げ)はやめ、見出しレベルにすることでアウトライン/目次に拾われやすくする(2026-10-20の要望)。
    return ws.categoryGroups.map(g => `### ${g.name || NO_CATEGORY_HEADING}\n\n${renderTable(g.items, columns)}`).join('\n\n');
  }
  return ws.sections.map(s => `### ${s.heading}\n\n${renderTable(s.items, columns)}`).join('\n\n');
}

function replaceVars(text, vars) {
  return text.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
}

/**
 * テンプレートにデータを流し込んでMarkdownを作る。
 * 未知のプレースホルダーはそのまま残し、warningsで知らせる。
 */
function renderWeeklyReport(data, { template, columns }) {
  const cols = normalizeColumns(columns);
  const text = typeof template === 'string' && template.trim() ? template : DEFAULT_TEMPLATE;
  const known = new Set(PLACEHOLDERS.map(p => p.name).filter(n => /^[A-Za-z]+$/.test(n)));
  const warnings = [];
  for (const m of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    const n = m[1];
    if (n !== '#workspace' && n !== '/workspace' && !known.has(n) && !warnings.includes(`未知のプレースホルダー: {{${n}}}`)) {
      warnings.push(`未知のプレースホルダー: {{${n}}}`);
    }
  }
  const opens = (text.match(/\{\{\s*#workspace\s*\}\}/g) || []).length;
  const closes = (text.match(/\{\{\s*\/workspace\s*\}\}/g) || []).length;
  if (opens !== closes || opens > 1) warnings.push('{{#workspace}}と{{/workspace}}は1組だけ、対で書いてください');

  const totalCount = data.workspaces.reduce((n, w) => n + w.count, 0);
  const global = {
    period: `${withDow(data.from)} 〜 ${withDow(data.to)}`,
    from: data.from,
    to: data.to,
    statuses: data.statuses.join(' / '),
    generatedAt: toJstDateTime(new Date().toISOString()),
    totalCount,
  };

  const block = /\{\{\s*#workspace\s*\}\}([\s\S]*?)\{\{\s*\/workspace\s*\}\}/;
  // 全体のプレースホルダーを先に展開し、そのあとでワークスペースの表を差し込む(表の中身は再展開しない)
  const rendered = replaceVars(text, global).replace(block, (m, inner) => data.workspaces.map(ws => {
    const c = ws.counts;
    const parts = [`完了 ${c.done}件`, `対応中 ${c.doing}件`];
    if (c.overdue) parts.push(`期限超過 ${c.overdue}件`);
    if (c.planned) parts.push(`未着手 ${c.planned}件`);
    // {{table}}の中身にプレースホルダー風の文字列(タスク件名など)が入っても再展開しないよう、最後に差し込む
    const body = replaceVars(inner, {
      workspaceId: ws.prefix, workspaceName: ws.name, workspaceFile: ws.file,
      summary: parts.join(' / '), statusCounts: renderStatusCounts(ws.statusCounts), doneCount: c.done, doingCount: c.doing, overdueCount: c.overdue, count: ws.count,
      table: '\u0000TABLE\u0000',
    });
    return body.replace('\u0000TABLE\u0000', () => renderWorkspaceTable(ws, cols));
  }).join(''));
  const markdown = rendered.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { markdown, warnings, totalCount };
}

/**
 * 入力(クエリ/ボディ)を検証して正規化する。不正なら { error } を返す。
 */
function parseReportOptions(input, config, db) {
  const range = input.range === 'last' || input.range === 'this' ? weekRange(input.range) : null;
  const from = range ? range.from : input.from;
  const to = range ? range.to : input.to;
  if (!isDate(from) || !isDate(to)) return { error: 'invalid_period', message: 'from/toはYYYY-MM-DD形式で指定してください' };
  if (from > to) return { error: 'invalid_period', message: '開始日が終了日より後です' };
  const known = (config.projects || []).map(p => p.file);
  const workspaces = Array.isArray(input.workspaces) && input.workspaces.length ? input.workspaces : known;
  const unknownWs = workspaces.find(w => !known.includes(w));
  if (unknownWs) return { error: 'unknown_workspace', message: `未登録のワークスペースです: ${unknownWs}` };
  const validStatuses = db.prepare('SELECT code FROM statuses').all().map(s => s.code);
  const statuses = Array.isArray(input.statuses) ? input.statuses : ['done', 'do'];
  const badStatus = statuses.find(s => !validStatuses.includes(s));
  if (badStatus) return { error: 'invalid_status', message: `不正なステータスです: ${badStatus}` };
  const groupByCategory = input.groupByCategory === true || input.groupByCategory === '1' || input.groupByCategory === 'true';
  // categories未指定=絞り込まない。配列の''(またはGETの__none__)はカテゴリなし
  let categories;
  if (Array.isArray(input.categories)) {
    if (input.categories.some(c => typeof c !== 'string')) return { error: 'invalid_category', message: 'categoriesは文字列の配列で指定してください' };
    categories = input.categories.map(c => (c === NO_CATEGORY_TOKEN ? '' : c));
  }
  return { from, to, workspaces, statuses, groupByCategory, categories };
}

function buildWeeklyReport(db, config, input, { template, columns }) {
  const opts = parseReportOptions(input, config, db);
  if (opts.error) return opts;
  const data = collectWeeklyReport(db, config, opts);
  const { markdown, warnings, totalCount } = renderWeeklyReport(data, { template, columns });
  return { ok: true, from: opts.from, to: opts.to, markdown, warnings, totalCount, data };
}

const TEMPLATE_FILE = 'weekly-report-template.json';
const TEMPLATE_MAX_LENGTH = 20000;

// 保存済みの書式(<backlogDir>配下のJSON)。無い/壊れている場合は既定にフォールバックする。
function loadTemplate(backlogDir) {
  const filePath = path.join(backlogDir, TEMPLATE_FILE);
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      template: typeof saved.template === 'string' && saved.template.trim() ? saved.template : DEFAULT_TEMPLATE,
      columns: normalizeColumns(saved.columns),
      saved: true,
    };
  } catch {
    return { template: DEFAULT_TEMPLATE, columns: DEFAULT_COLUMNS.slice(), saved: false };
  }
}

function saveTemplate(backlogDir, { template, columns }) {
  if (typeof template !== 'string' || !template.trim()) return { error: 'invalid_template', message: '書式が空です' };
  if (template.length > TEMPLATE_MAX_LENGTH) return { error: 'invalid_template', message: `書式は${TEMPLATE_MAX_LENGTH}文字までです` };
  const data = { template, columns: normalizeColumns(columns) };
  const filePath = path.join(backlogDir, TEMPLATE_FILE);
  fs.mkdirSync(backlogDir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
  return { ok: true, ...data };
}

function resetTemplate(backlogDir) {
  fs.rmSync(path.join(backlogDir, TEMPLATE_FILE), { force: true });
  return { ok: true, template: DEFAULT_TEMPLATE, columns: DEFAULT_COLUMNS.slice() };
}

module.exports = {
  loadTemplate, saveTemplate, resetTemplate, TEMPLATE_MAX_LENGTH,
  COLUMN_DEFS, DEFAULT_COLUMNS, DEFAULT_TEMPLATE, PLACEHOLDERS,
  weekRange, normalizeColumns, collectWeeklyReport, buildWeeklyCounts, renderWeeklyReport, buildWeeklyReport, parseReportOptions,
};
