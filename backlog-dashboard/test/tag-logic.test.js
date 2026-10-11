'use strict';

// BT-394: タグ管理画面の純粋ロジック(public/tag-logic.js)と、画面の配線(静的チェック)を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const tagLogic = require('../public/tag-logic');
const tagsRepo = require('../db/tags-repo');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const tagsJs = fs.readFileSync(path.join(publicDir, 'tags.js'), 'utf8');

test('クライアント側の正規化はサーバー(tags-repo)のname_keyと一致する', () => {
  for (const name of ['ＡＢＣ', '  Backend  ', 'ガント　チャート', 'ﾊﾞｯｸｴﾝﾄﾞ', 'Mixed  Case']) {
    assert.equal(tagLogic.cleanTagName(name), tagsRepo.cleanName(name));
    assert.equal(tagLogic.tagNameKey(name), tagsRepo.toNameKey(tagsRepo.cleanName(name)));
  }
});

test('findExactTagは表記ゆれ込みで一致を探し、改名時は自分自身を除外する', () => {
  const tags = [{ id: 1, name: 'Backend' }, { id: 2, name: 'ガント' }];
  assert.equal(tagLogic.findExactTag(tags, 'ｂａｃｋｅｎｄ').id, 1);
  assert.equal(tagLogic.findExactTag(tags, ' ガント ').id, 2);
  assert.equal(tagLogic.findExactTag(tags, 'backend', 1), null);
  assert.equal(tagLogic.findExactTag(tags, '   '), null);
  assert.equal(tagLogic.findExactTag(tags, 'other'), null);
});

test('readableTextColorは明るい色に黒、暗い色に白、色なしはnull', () => {
  assert.equal(tagLogic.readableTextColor('#ffffff'), '#1a1a1a');
  assert.equal(tagLogic.readableTextColor('#ffeb3b'), '#1a1a1a');
  assert.equal(tagLogic.readableTextColor('#000000'), '#ffffff');
  assert.equal(tagLogic.readableTextColor('#336699'), '#ffffff');
  assert.equal(tagLogic.readableTextColor(null), null);
  assert.equal(tagLogic.readableTextColor('red'), null);
});

test('削除・統合の確認メッセージは影響するタスク件数を示す', () => {
  assert.match(tagLogic.buildDeleteMessage({ name: 'A', usageCount: 3 }), /3 件のタスクからも外れます/);
  assert.doesNotMatch(tagLogic.buildDeleteMessage({ name: 'A', usageCount: 0 }), /タスク/);
  const merge = tagLogic.buildMergeMessage({ name: 'Src', usageCount: 2 }, { name: 'Dst' });
  assert.match(merge, /「Src」を「Dst」に統合/);
  assert.match(merge, /2 件のタスクは「Dst」に付け替わります/);
  assert.match(merge, /「Src」は削除され/);
});

test('describeTagErrorはサーバーのエラーを画面向けに変換する', () => {
  const dup = tagLogic.describeTagError({ error: 'duplicate_tag', existing: { name: 'Backend' } });
  assert.equal(dup.kind, 'duplicate');
  assert.match(dup.message, /Backend/);
  const similar = tagLogic.describeTagError({ error: 'similar_tags', similar: [{ name: 'ガントチャート' }, { name: 'ガント図' }] });
  assert.equal(similar.kind, 'similar');
  assert.deepEqual(similar.similar.map(t => t.name), ['ガントチャート', 'ガント図']);
  assert.match(similar.message, /ガントチャート、ガント図/);
  assert.equal(tagLogic.describeTagError({ error: 'invalid_name', message: 'タグ名が空です' }).message, 'タグ名が空です');
  assert.equal(tagLogic.describeTagError(null).kind, 'error');
});

test('タグボタンは1段目のバックアップボタンの右にあり、スクリプトとアイコンが揃っている', () => {
  const backup = html.indexOf('id="backup-btn"');
  const tag = html.indexOf('id="tag-btn"');
  assert.ok(backup > 0 && tag > backup, 'バックアップボタンより後ろに置く');
  assert.ok(tag < html.indexOf('header-workspace-row'), '1段目に置く');
  assert.ok(html.indexOf('<script src="tag-logic.js">') < html.indexOf('<script src="tags.js">'), 'ロジックを先に読み込む');
  assert.ok(html.indexOf('<script src="app.js">') < html.indexOf('<script src="tags.js">'), 'app.jsのヘルパーに依存するので後に読み込む');
  assert.ok(fs.existsSync(path.join(publicDir, 'icons', 'local_offer.svg')));
  assert.match(css, /\.material-icon\.icon-tag\s*\{[^}]*icons\/local_offer\.svg/);
});

test('タグモーダルは最前面判定(Escape制御)の対象に含まれ、旧サーバー向けの案内を持つ', () => {
  assert.match(app, /\.tag-modal-overlay\.modal-visible/);
  assert.match(tagsJs, /isTopmostDialog\(tagModalEl\)/);
  assert.match(tagsJs, /サーバーを最新版へ再起動/);
  assert.match(tagsJs, /confirmSimilar/);
});

test('buildTagChipHtmlは名前・色をエスケープし、色ありは文字色を付ける', () => {
  const html = tagLogic.buildTagChipHtml({ id: 7, name: '<b>"x"&', color: '#e53935' }, { removable: true });
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;b&gt;&quot;x&quot;&amp;/);
  assert.match(html, /background:#e53935;color:#ffffff/);
  assert.match(html, /data-tag-id="7"/);
  const plain = tagLogic.buildTagChipHtml({ id: 1, name: 'A', color: null });
  assert.match(plain, /tag-chip-plain/);
  assert.doesNotMatch(plain, /style=|tag-chip-remove/);
  // 不正な色はスタイルへ流さない(属性インジェクション対策)
  assert.doesNotMatch(tagLogic.buildTagChipHtml({ id: 1, name: 'A', color: '#fff;" onclick="x' }), /style=|onclick/);
});

test('buildCardTagsHtmlはカード用に小さく、上限超過は+Nにまとめ、子由来は薄くする', () => {
  assert.equal(tagLogic.buildCardTagsHtml([], []), '');
  assert.equal(tagLogic.buildCardTagsHtml(null, null), '');
  const tags = [1, 2, 3, 4, 5].map(i => ({ id: i, name: `t${i}`, color: null }));
  const html = tagLogic.buildCardTagsHtml(tags.slice(0, 2), tags.slice(2), 3);
  assert.equal((html.match(/tag-chip-sm/g) || []).length, 4, '表示3件+「+N」');
  assert.match(html, /tag-chip-more[^>]*title="t4、t5">\+2</);
  assert.equal((html.match(/tag-chip-dim/g) || []).length, 1, '子由来は上限内の1件だけ薄く表示');
  assert.doesNotMatch(tagLogic.buildCardTagsHtml(tags.slice(0, 3), null, 3), /tag-chip-more/);
});

test('カード・詳細・登録フォームへタグ表示/選択が配線されている', () => {
  assert.match(app, /tagLogic\.buildCardTagsHtml\(item\.tags, item\.childTags\)/);
  assert.match(app, /isCompact \? '' : tagLogic\.buildCardTagsHtml/, '完了カラムのコンパクトカードには出さない');
  assert.match(app, /tagLogic\.buildCardTagsHtml\(child\.tags, null\)/, 'ミニボードの子カード');
  assert.match(app, /return buildDetailTagsHtml\(item\) \+ infoHtml;/);
  assert.match(app, /id="add-task-tags"/);
  assert.match(app, /resetAddFormTags\(addFormEl\)/);
  assert.match(app, /\/api\/update-task-tags/);
  assert.ok(html.indexOf('<script src="tag-logic.js">') < html.indexOf('<script src="app.js">'), 'app.jsがtagLogicを使うので先に読み込む');
  assert.match(css, /\.tag-chip-sm\s*\{[^}]*font-size:\s*calc\(var\(--fs-tag, 0\.65rem\) \* 0\.8\)/, 'カードサイズ設定(--fs-tag)に連動する');
  assert.match(css, /\.tag-picker\s*\{[^}]*z-index:\s*1300/);
  assert.match(tagsJs, /stopImmediatePropagation\(\)[\s\S]{0,40}closeTagPicker\(\)/, 'Escはピッカーだけを先に閉じる');
});

test('色見本はピッカー値(#rrggbb小文字)で、白黒どちらかの文字色が決まり、選択中だけaria-pressedになる', () => {
  const palette = tagLogic.TAG_COLOR_PALETTE;
  assert.ok(palette.length >= 12);
  assert.equal(new Set(palette.map(c => c.value)).size, palette.length, '色の重複なし');
  for (const c of palette) {
    assert.match(c.value, /^#[0-9a-f]{6}$/, 'type=colorにそのまま入る形式');
    assert.ok(['#1a1a1a', '#ffffff'].includes(tagLogic.readableTextColor(c.value)));
    assert.ok(c.name);
  }
  const html = tagLogic.buildSwatchesHtml('#E53935');
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(html, /data-color="#e53935"[^>]*>/);
  assert.match(html, /aria-pressed="true"[^>]*style="background:#e53935"/);
  assert.match(tagLogic.buildSwatchesHtml(null), /data-color=""[^>]*aria-pressed="true"/, '色なしが選択状態');
  assert.equal((tagLogic.buildSwatchesHtml(null).match(/aria-pressed="true"/g) || []).length, 1);
  assert.equal((tagLogic.buildSwatchesHtml('#123456').match(/aria-pressed="true"/g) || []).length, 0, '見本にない色はどれも押下状態にしない');
  assert.equal((html.match(/<button/g) || []).length, palette.length + 1, '色なし+見本');
});

test('タグ管理の色指定は見本クリックとカラーピッカーを同期する配線になっている', () => {
  assert.match(tagsJs, /tagLogic\.buildSwatchesHtml\(''\)/, '作成フォーム');
  assert.match(tagsJs, /tagLogic\.buildSwatchesHtml\(tag\.color\)/, '編集行は現在の色を押下状態にする');
  assert.match(tagsJs, /function syncTagSwatches\(field\)/);
  assert.match(css, /\.tag-swatch\[aria-pressed="true"\]\s*\{[^}]*outline/);
  assert.match(css, /\.tag-swatch-none\s*\{/);
});

test('タグ管理モーダルは詳細・登録フォームより手前、ピッカーとバックアップ進捗より後ろに重なる', () => {
  // 「selector {」で始まるルールブロックからz-indexを読む(同じ接頭辞の別ルールは拾わない)
  const z = (selector) => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, `${selector} のルールがある`);
    const block = css.slice(start, css.indexOf('}', start));
    return Number(/z-index:\s*(\d+)/.exec(block)[1]);
  };
  const tagModal = z('.tag-modal-overlay');
  assert.ok(tagModal > z('.modal-overlay.modal-front'), '登録フォーム(前面モーダル)より手前');
  assert.ok(tagModal > z('.modal-overlay'), '詳細モーダル(.modal-overlay)より手前');
  assert.ok(tagModal < z('.tag-picker'), 'ピッカーより後ろ');
  assert.ok(tagModal < z('.backup-progress-overlay'), 'バックアップ進捗(全操作ブロック)より後ろ');
  assert.match(css, /\.modal-overlay\s*\{[^}]*z-index:\s*1000/, '詳細モーダルの層の前提');
});

test('matchesTagFilterはタグ名(表記ゆれ込み)で、orはどれか・andはすべてを判定し、空の条件は常に一致する', () => {
  const tags = [{ name: 'Backend' }, { name: 'ガント' }];
  assert.equal(tagLogic.matchesTagFilter(tags, [], 'or'), true);
  assert.equal(tagLogic.matchesTagFilter([], [], 'and'), true);
  assert.equal(tagLogic.matchesTagFilter(tags, ['backend', 'other'], 'or'), true);
  assert.equal(tagLogic.matchesTagFilter(tags, ['backend', 'other'], 'and'), false);
  assert.equal(tagLogic.matchesTagFilter(tags, ['backend', 'ガント'], 'and'), true);
  assert.equal(tagLogic.matchesTagFilter([], ['backend'], 'or'), false);
  assert.equal(tagLogic.matchesTagFilter(null, ['backend'], 'or'), false);
  // タグ名の正規化(全角・大文字)を経ても同じキーとして一致する
  assert.equal(tagLogic.matchesTagFilter([{ name: 'ＢＡＣＫＥＮＤ' }], ['backend'], 'or'), true);
});

test('EPICのボード判定は自分のタグに子由来のタグを足す(子がタグを持てば親も出る)', () => {
  const epic = { tags: [{ name: 'A' }], childTags: [{ name: 'B' }] };
  assert.equal(tagLogic.matchesTagFilterForBoardItem(epic, ['b'], 'or'), true, '子のタグだけでも親が出る');
  assert.equal(tagLogic.matchesTagFilterForBoardItem(epic, ['a', 'b'], 'and'), true, 'andは自分+子の和集合で判定');
  assert.equal(tagLogic.matchesTagFilterForBoardItem(epic, ['a', 'c'], 'and'), false);
  assert.equal(tagLogic.matchesTagFilterForBoardItem({ tags: [{ name: 'A' }] }, ['b'], 'or'), false);
  assert.equal(tagLogic.matchesTagFilterForBoardItem({}, ['a'], 'or'), false, 'タグ情報のないitemも落ちない');
});

test('buildTagFilterOptionsは同名タグを合算し、使用中のものだけを使用数の多い順に返す', () => {
  const options = tagLogic.buildTagFilterOptions([
    { name: 'Backend', color: '#336699', usageCount: 2 },
    { name: 'ｂａｃｋｅｎｄ', color: null, usageCount: 3 }, // 別ワークスペースの同名タグ(全角)
    { name: '重要', color: '#e53935', usageCount: 9 },
    { name: '未使用', color: null, usageCount: 0 },
  ]);
  assert.deepEqual(options.map(o => [o.key, o.name, o.usageCount]), [['重要', '重要', 9], ['backend', 'Backend', 5]]);
  assert.equal(options[1].color, '#336699', '最初に見つかった色を使う');
  assert.deepEqual(tagLogic.buildTagFilterOptions(null), []);
});

test('parseTagFilterは壊れた保存値を絞り込みなしに戻し、不正な色や項目を捨てる', () => {
  const empty = { mode: 'or', tags: [] };
  assert.deepEqual(tagLogic.parseTagFilter(null), empty);
  assert.deepEqual(tagLogic.parseTagFilter('{broken'), empty);
  assert.deepEqual(tagLogic.parseTagFilter('{"mode":"and","tags":"x"}'), { mode: 'and', tags: [] });
  const parsed = tagLogic.parseTagFilter(JSON.stringify({
    mode: 'weird',
    tags: [{ key: 'a', name: 'A', color: '#e53935' }, { key: 'b', name: 'B', color: 'red' }, { name: 'no key' }, null],
  }));
  assert.equal(parsed.mode, 'or');
  assert.deepEqual(parsed.tags, [{ key: 'a', name: 'A', color: '#e53935' }, { key: 'b', name: 'B', color: null }]);
});

test('describeTagFilterは条件をorなら「または」andなら「かつ」でつなぎ、なしは空文字', () => {
  assert.equal(tagLogic.describeTagFilter({ mode: 'or', tags: [] }), '');
  assert.equal(tagLogic.describeTagFilter(null), '');
  const tags = [{ key: 'a', name: '重要' }, { key: 'b', name: '調査' }];
  assert.equal(tagLogic.describeTagFilter({ mode: 'or', tags }), 'タグ: 重要 または 調査');
  assert.equal(tagLogic.describeTagFilter({ mode: 'and', tags }), 'タグ: 重要 かつ 調査');
});

test('タグ絞り込みはボード・週次計画・ガントに配線され、ヘッダーにボタンと絞り込みバーがある', () => {
  const has = (src, text) => assert.ok(src.includes(text), `含まれる: ${text}`);
  has(app, "tagLogic.parseTagFilter(");
  has(app, 'tagLogic.matchesTagFilterForBoardItem(item, tagKeys, tagFilter.mode)');
  has(app, 'function planMatchesTags(item, epic)');
  assert.equal((app.match(/planMatchesTags\(/g) || []).length, 5, '定義1+週次計画(子・単発)+ガント(子・単発)');
  has(app, 'tagLogic.describeTagFilter(tagFilter)');
  assert.equal((app.match(/tagFilter\.tags\.length > 0/g) || []).length >= 3, true, '各絞り込み判定にタグ条件が入る');
  has(html, 'id="tag-filter-btn"');
  has(html, 'id="tag-filter-bar"');
  // 1段目のボタン群は幅が限界(増やすとヘッダーが横にはみ出す)のため、バッジ行の右端に置く
  assert.ok(html.indexOf('id="tag-filter-btn"') > html.indexOf('class="header-badges-row"'), 'バッジ行に置く');
  assert.ok(html.indexOf('id="tag-filter-btn"') > html.indexOf('id="project-badges"'), 'プロジェクトバッジの右');
  has(tagsJs, 'function applyTagFilter()');
  has(tagsJs, 'renderPlanBoard');
  has(tagsJs, "localStorage.setItem('tagFilter'");
  has(css, '.tag-filter-btn.filter-active');
});

test('週次計画・ガント画面の中にも、ヘッダーと状態を共有するタグ絞り込みボタンがある (BT-397)', () => {
  const has = (src, text) => assert.ok(src.includes(text), `含まれる: ${text}`);
  has(app, 'id="plan-tag-filter-btn"');
  has(app, "overlay.querySelector('#plan-tag-filter-btn').addEventListener('click', (e) => toggleTagFilterPopover(e.currentTarget));");
  has(html, 'class="activity-btn tag-filter-btn tag-filter-trigger"');
  has(tagsJs, 'function toggleTagFilterPopover(anchor)');
  has(tagsJs, "document.querySelectorAll('.tag-filter-trigger')");
  has(tagsJs, "e.target.closest('.tag-filter-trigger')");
  has(css, '.plan-tag-filter-btn');
  // ポップオーバー(1300)は計画画面(.plan-board-overlay)より手前に出る
  const z = (selector) => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, `${selector} のルールがある`);
    return Number(/z-index:\s*(\d+)/.exec(css.slice(start, css.indexOf('}', start)))[1]);
  };
  assert.ok(z('.tag-picker') > z('.plan-board-overlay'), 'ポップオーバーは計画画面より手前');
  assert.ok(z('.tag-modal-overlay') > z('.plan-board-overlay'), 'タグ管理も計画画面より手前');
});

test('ガントはタイトルの右にタグを出し、タグ絞り込みの画面には「クリア」(選択解除)がある', () => {
  const has = (src, text) => assert.ok(src.includes(text), `含まれる: ${text}`);
  const gantt = fs.readFileSync(path.join(publicDir, 'gantt.js'), 'utf8');
  const ganttCss = fs.readFileSync(path.join(publicDir, 'gantt.css'), 'utf8');
  has(gantt, 'const tagsCell = (it) =>');
  has(gantt, '${esc(item.title)}</span>${tagsCell(item)}');
  has(gantt, '${esc(r.epic.title)}</span>${tagsCell(r.epic)}');
  has(app, 'tagsHtml: (item) => tagLogic.buildCardTagsHtml(item.tags, item.childTags, 2)');
  has(ganttCss, '.gantt-tags {');
  // タグはタイトルより先に縮まず、はみ出す分は切る(タイトルを押しつぶさないよう幅の上限を持つ)
  assert.ok(/\.gantt-tags \{[^}]*max-width:\s*\d+%/.test(ganttCss));
  // クリア: ボタンは条件切替の行にあり、選択が無いときは押せない。旧「絞り込みを解除」(フッター)は置き換え
  has(tagsJs, 'class="tag-filter-clear-sel" data-act="clear"');
  has(tagsJs, "el.querySelector('.tag-filter-clear-sel').disabled = tagFilter.tags.length === 0;");
  assert.ok(!tagsJs.includes('絞り込みを解除</button>'), 'フッターの旧ボタンは廃止');
  has(css, '.tag-filter-clear-sel:disabled');
});
