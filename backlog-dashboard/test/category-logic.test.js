'use strict';

// BM-106: カテゴリ管理画面の純粋ロジック(public/category-logic.js)と、画面の配線(静的チェック)を検証する。
// tag-logic.test.jsと同じ観点。カテゴリは1タスク1値のためand/or切替・複数選択ピッカーは持たない。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const categoryLogic = require('../public/category-logic');
const categoriesRepo = require('../db/categories-repo');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const categoriesJs = fs.readFileSync(path.join(publicDir, 'categories.js'), 'utf8');

test('クライアント側の正規化はサーバー(db/name-normalizer経由のcategories-repo)のname_keyと一致する', () => {
  for (const name of ['ＡＢＣ', '  Infra  ', 'ガント　チャート', 'ﾊﾞｯｸｴﾝﾄﾞ', 'Mixed  Case']) {
    // categories-repoはcleanName/toNameKeyを直接エクスポートしないため、resolveCategoryName経由の
    // name_key一致を別ファイルで検証する代わりに、ここではname-normalizerと同じ正規化規則であることを確認する
    const { cleanName, toNameKey } = require('../db/name-normalizer');
    assert.equal(categoryLogic.cleanCategoryName(name), cleanName(name));
    assert.equal(categoryLogic.categoryNameKey(name), toNameKey(cleanName(name)));
  }
});

test('findExactCategoryは表記ゆれ込みで一致を探し、改名時は自分自身を除外する', () => {
  const categories = [{ id: 1, name: 'Infra' }, { id: 2, name: 'ガント' }];
  assert.equal(categoryLogic.findExactCategory(categories, 'ｉｎｆｒａ').id, 1);
  assert.equal(categoryLogic.findExactCategory(categories, ' ガント ').id, 2);
  assert.equal(categoryLogic.findExactCategory(categories, 'infra', 1), null);
  assert.equal(categoryLogic.findExactCategory(categories, '   '), null);
  assert.equal(categoryLogic.findExactCategory(categories, 'other'), null);
});

test('readableTextColorは明るい色に黒、暗い色に白、色なしはnull', () => {
  assert.equal(categoryLogic.readableTextColor('#ffffff'), '#1a1a1a');
  assert.equal(categoryLogic.readableTextColor('#000000'), '#ffffff');
  assert.equal(categoryLogic.readableTextColor(null), null);
  assert.equal(categoryLogic.readableTextColor('red'), null);
});

test('削除・統合の確認メッセージは影響するタスク件数を示す', () => {
  assert.match(categoryLogic.buildDeleteMessage({ name: 'A', usageCount: 3 }), /3 件のタスクはカテゴリなしになります/);
  assert.doesNotMatch(categoryLogic.buildDeleteMessage({ name: 'A', usageCount: 0 }), /タスク/);
  const merge = categoryLogic.buildMergeMessage({ name: 'Src', usageCount: 2 }, { name: 'Dst' });
  assert.match(merge, /「Src」を「Dst」に統合/);
  assert.match(merge, /2 件のタスクは「Dst」に付け替わります/);
});

test('describeCategoryErrorはサーバーのエラーを画面向けに変換する', () => {
  const dup = categoryLogic.describeCategoryError({ error: 'duplicate_category', existing: { name: 'Infra' } });
  assert.equal(dup.kind, 'duplicate');
  assert.match(dup.message, /Infra/);
  const similar = categoryLogic.describeCategoryError({ error: 'similar_categories', similar: [{ name: 'インフラ' }, { name: 'インフラ基盤' }] });
  assert.equal(similar.kind, 'similar');
  assert.deepEqual(similar.similar.map(c => c.name), ['インフラ', 'インフラ基盤']);
  const unknown = categoryLogic.describeCategoryError({ error: 'unknown_category', message: 'カテゴリが見つかりません: X' });
  assert.equal(unknown.kind, 'unknown');
  assert.equal(categoryLogic.describeCategoryError(null).kind, 'error');
});

test('buildCategoryChipHtmlは名前・色をエスケープし、色ありはマスタ色を薄く混ぜる(BT-454でbuildCategoryBadgeHtmlに一本化)', () => {
  const chip = categoryLogic.buildCategoryChipHtml({ name: '<b>"x"&', color: '#e53935' });
  assert.doesNotMatch(chip, /<b>/);
  assert.match(chip, /&lt;b&gt;&quot;x&quot;&amp;/);
  assert.match(chip, /color-mix\(in srgb, #e53935 22%/);
  assert.match(chip, /category-badge/);
  assert.equal(chip, categoryLogic.buildCategoryBadgeHtml('<b>"x"&', '#e53935'));
  const plain = categoryLogic.buildCategoryChipHtml({ name: 'A', color: null });
  assert.match(plain, /tag-chip-plain/);
  assert.doesNotMatch(plain, /style=/);
});

test('buildCategoryBadgeHtml(BT-454)はカテゴリアイコン付きで、色ありはマスタ色を薄く混ぜ、色なし・名前なしはニュートラル', () => {
  const badge = categoryLogic.buildCategoryBadgeHtml('<b>バグ</b>', '#e53935', { small: true });
  assert.doesNotMatch(badge, /<b>/);
  assert.match(badge, /&lt;b&gt;バグ&lt;\/b&gt;/);
  assert.match(badge, /icon-stacks/);
  assert.doesNotMatch(badge, /icon-tag/);
  assert.match(badge, /tag-chip-sm/);
  assert.match(badge, /color-mix\(in srgb, #e53935 22%/);
  const plain = categoryLogic.buildCategoryBadgeHtml('機能追加', '');
  assert.match(plain, /tag-chip-plain/);
  assert.doesNotMatch(plain, /style=/);
  assert.doesNotMatch(plain, /tag-chip-sm/);
  const none = categoryLogic.buildCategoryBadgeHtml('', '#e53935');
  assert.match(none, /カテゴリなし/);
  assert.doesNotMatch(none, /style=/);
});

test('ボード・子カード・詳細のカテゴリ表示は固定色バッジではなく色付きチップを使う(BT-454)', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /card-tag category/);
  assert.doesNotMatch(app, /detail-tag category/);
  assert.equal((app.match(/categoryBadgeHtml\(/g) || []).length >= 5, true);
});

test('matchesCategoryFilterは1値のためいずれかの選択に一致するかで判定し、空の条件は常に一致する', () => {
  assert.equal(categoryLogic.matchesCategoryFilter('Infra', []), true);
  assert.equal(categoryLogic.matchesCategoryFilter('-', []), true);
  assert.equal(categoryLogic.matchesCategoryFilter('Infra', ['infra']), true);
  assert.equal(categoryLogic.matchesCategoryFilter('Infra', ['other']), false);
  assert.equal(categoryLogic.matchesCategoryFilter('Infra', ['infra', 'other']), true);
  assert.equal(categoryLogic.matchesCategoryFilter('-', ['infra']), false);
  assert.equal(categoryLogic.matchesCategoryFilter(null, ['infra']), false);
  assert.equal(categoryLogic.matchesCategoryFilter('ＩＮＦＲＡ', ['infra']), true, '全角でも同じキーとして一致する');
});

test('matchesCategoryFilterForBoardItemはitem.categoryをそのまま見る(子からの導出はしない)', () => {
  assert.equal(categoryLogic.matchesCategoryFilterForBoardItem({ category: 'Infra' }, ['infra']), true);
  assert.equal(categoryLogic.matchesCategoryFilterForBoardItem({ category: '-' }, ['infra']), false);
  assert.equal(categoryLogic.matchesCategoryFilterForBoardItem({}, ['infra']), false);
});

test('buildCategoryFilterOptionsは同名カテゴリを合算し、使用中のものだけを使用数の多い順に返す', () => {
  const options = categoryLogic.buildCategoryFilterOptions([
    { name: 'Infra', color: '#336699', usageCount: 2 },
    { name: 'ｉｎｆｒａ', color: null, usageCount: 3 },
    { name: '重要', color: '#e53935', usageCount: 9 },
    { name: '未使用', color: null, usageCount: 0 },
  ]);
  assert.deepEqual(options.map(o => [o.key, o.name, o.usageCount]), [['重要', '重要', 9], ['infra', 'Infra', 5]]);
  assert.equal(options[1].color, '#336699', '最初に見つかった色を使う');
  assert.deepEqual(categoryLogic.buildCategoryFilterOptions(null), []);
});

test('parseCategoryFilterは壊れた保存値を絞り込みなしに戻し、不正な項目を捨てる', () => {
  const empty = { keys: [] };
  assert.deepEqual(categoryLogic.parseCategoryFilter(null), empty);
  assert.deepEqual(categoryLogic.parseCategoryFilter('{broken'), empty);
  assert.deepEqual(categoryLogic.parseCategoryFilter('{"keys":"x"}'), empty);
  const parsed = categoryLogic.parseCategoryFilter(JSON.stringify({ keys: ['a', 'b', '', 123, null] }));
  assert.deepEqual(parsed.keys, ['a', 'b']);
});

test('色見本はタグと同じパレットを共有する(配色の一貫性)', () => {
  const palette = categoryLogic.CATEGORY_COLOR_PALETTE;
  assert.ok(palette.length >= 12);
  for (const c of palette) {
    assert.match(c.value, /^#[0-9a-f]{6}$/);
    assert.ok(['#1a1a1a', '#ffffff'].includes(categoryLogic.readableTextColor(c.value)));
  }
  const html = categoryLogic.buildSwatchesHtml('#E53935');
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
});

test('カテゴリ管理モーダル・絞り込みボタン・追加/編集フォームのセレクトが画面に配線されている (BM-106)', () => {
  const has = (src, text) => assert.ok(src.includes(text), `含まれる: ${text}`);
  has(html, 'id="category-filter-btn"');
  has(app, 'id="add-task-category"');
  has(app, 'id="edit-task-category"');
  has(app, 'categoryLogic.matchesCategoryFilterForBoardItem(item, categoryFilter.keys)');
  has(app, "category: form.querySelector('#add-task-category').value");
  has(app, "category: categoryInput.value");
  has(categoriesJs, 'function openCategoryModal()');
  has(categoriesJs, 'function toggleCategoryFilterPopover(anchor)');
  has(categoriesJs, "localStorage.setItem('categoryFilter'");
  assert.ok(html.indexOf('<script src="tag-logic.js">') < html.indexOf('<script src="category-logic.js">'), 'タグに続けて読み込む');
  assert.ok(html.indexOf('<script src="category-logic.js">') < html.indexOf('<script src="app.js">'), 'app.jsがcategoryLogicを使うので先に読み込む');
  assert.ok(html.indexOf('<script src="app.js">') < html.indexOf('<script src="categories.js">'), 'app.jsのヘルパーに依存するので後に読み込む');
  has(css, '.category-modal-overlay');
  has(css, '.category-filter-btn.filter-active');
  has(css, '.category-select-row');
});

test('カテゴリモーダルは最前面判定(Escape制御)の対象に含まれる', () => {
  assert.match(app, /\.category-modal-overlay\.modal-visible/);
  assert.match(categoriesJs, /isTopmostDialog\(categoryModalEl\)/);
});

// BT-445: カード・複数選択バーのカテゴリ選択ピッカー
test('commonCategoryKey: 全員同じならそのキー、全員なしなら空文字、バラバラならnull', () => {
  assert.equal(categoryLogic.commonCategoryKey([{ category: '調査' }, { category: ' 調査 ' }]), '調査');
  assert.equal(categoryLogic.commonCategoryKey([{ category: '-' }, { category: '' }, {}]), '');
  assert.equal(categoryLogic.commonCategoryKey([{ category: '調査' }, { category: '-' }]), null);
  assert.equal(categoryLogic.commonCategoryKey([{ category: 'A' }, { category: 'B' }]), null);
  assert.equal(categoryLogic.commonCategoryKey([]), null);
});

test('カード・複数選択バーにカテゴリ導線が配線されている(アイコンはヘッダのカテゴリボタンと同じicon-stacks)', () => {
  assert.match(app, /card-category-btn[^>]*><span class="material-icon icon-stacks">/);
  assert.match(app, /id="selection-category"[^>]*><span class="material-icon icon-stacks">/);
  assert.match(app, /openCardCategoryPicker\(btn\)/);
  assert.match(app, /openBulkCategoryPicker\(event\.currentTarget\)/);
  assert.match(categoriesJs, /function openCategoryPicker\(/);
  assert.match(css, /\.selection-bar-category:hover/);
});

test('EPIC内の子カード(ミニボード)にもカテゴリボタンが付き、子itemも解決できる (BT-445)', () => {
  assert.match(app, /card-category-btn" data-task-id="\$\{child\.id\}"/);
  assert.match(app, /openCardCategoryPicker\(childCategoryBtnEl\)/);
  assert.match(categoriesJs, /findItemById\(taskId\) \|\| findChildItemById\(taskId\)/);
});
