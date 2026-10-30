
'use strict';

// BM-136: タスクコメントの純粋ロジック(public/comment-logic.js)と、画面の配線(静的チェック)を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const logic = require('../public/comment-logic');

const publicDir = path.join(__dirname, '..', 'public');
const read = name => fs.readFileSync(path.join(publicDir, name), 'utf8');

const NOW = new Date('2026-10-22T06:00:00.000Z'); // JST 15:00

test('formatCommentDate: 今年は月/日、他の年は年付き。日付の境目はJSTで判定する', () => {
  assert.equal(logic.formatCommentDate('2026-10-22T01:00:00.000Z', NOW), '10/22');
  assert.equal(logic.formatCommentDate('2026-10-21T15:30:00.000Z', NOW), '10/22', 'UTCでは前日でもJSTでは翌日0:30');
  assert.equal(logic.formatCommentDate('2025-12-30T01:00:00.000Z', NOW), '2025/12/30');
  assert.equal(logic.formatCommentDate('not a date', NOW), '');
  assert.equal(logic.formatCommentDate(undefined, NOW), '');
});

test('formatCommentDateTime: JSTの "YYYY-MM-DD HH:mm"', () => {
  assert.equal(logic.formatCommentDateTime('2026-10-22T06:05:00.000Z'), '2026-10-22 15:05');
  assert.equal(logic.formatCommentDateTime('2026-12-31T15:00:00.000Z'), '2027-01-01 00:00');
  assert.equal(logic.formatCommentDateTime(''), '');
});

test('firstLine: 先頭の空でない行を返す', () => {
  assert.equal(logic.firstLine('1行目\n2行目'), '1行目');
  assert.equal(logic.firstLine('\n\n  本文  \n次'), '本文');
  assert.equal(logic.firstLine('   '), '');
  assert.equal(logic.firstLine(null), '');
});

test('buildCardCommentHtml: コメントなしは空、あれば アイコン+日付+本文1行、HTMLはエスケープする', () => {
  assert.equal(logic.buildCardCommentHtml(null, NOW), '');
  assert.equal(logic.buildCardCommentHtml({ body: '   ', createdAt: '2026-10-22T01:00:00.000Z' }, NOW), '');

  const html = logic.buildCardCommentHtml({
    id: 1, body: '検証機で再現\n2行目は出さない <b>x</b>', createdAt: '2026-10-22T01:00:00.000Z', createdBy: 'kiro',
  }, NOW);
  assert.match(html, /^<div class="card-comment"/);
  assert.match(html, /icon-chat-bubble/);
  assert.match(html, /<span class="card-comment-date">10\/22<\/span>/);
  assert.match(html, /<span class="card-comment-text">検証機で再現<\/span>/);
  assert.ok(!html.includes('<b>'), '本文のHTMLは実行させない');
  // ツールチップには日時・投稿者・本文全体(2行目以降も)を出す
  assert.ok(html.includes('title="2026-10-22 10:00 kiro\n検証機で再現\n2行目は出さない &lt;b&gt;x&lt;/b&gt;"'), html);
});

test('resolveComments: 件数が合うキャッシュ > 件数が合う詳細 > 古いキャッシュ(要再取得) > 未取得', () => {
  const cached = [{ id: 2 }, { id: 1 }];
  const detail = [{ id: 3 }, { id: 2 }, { id: 1 }];

  assert.deepEqual(logic.resolveComments({ commentCount: 0 }, undefined), { comments: [], needsFetch: false });
  assert.deepEqual(logic.resolveComments({ commentCount: 0 }, cached), { comments: [], needsFetch: false }, '件数0ならキャッシュが古くても空');
  assert.deepEqual(logic.resolveComments({ commentCount: 2 }, cached), { comments: cached, needsFetch: false });
  assert.deepEqual(logic.resolveComments({ commentCount: 3, comments: detail }, cached), { comments: detail, needsFetch: false }, 'キャッシュが古ければ詳細を使う');
  assert.deepEqual(logic.resolveComments({ commentCount: 3 }, cached), { comments: cached, needsFetch: true }, '古いキャッシュを見せつつ取り直す');
  assert.deepEqual(logic.resolveComments({ commentCount: 3 }, undefined), { comments: null, needsFetch: true }, '未取得は読み込み中');
  assert.deepEqual(logic.resolveComments({ id: 'X-1' }, undefined), { comments: null, needsFetch: true }, '件数が不明でも取得する');
  assert.deepEqual(logic.resolveComments({ id: 'X-1' }, cached), { comments: cached, needsFetch: false }, '件数が不明ならキャッシュを信じる');
});

test('hasDraftText: 空白だけは書きかけとみなさない', () => {
  assert.equal(logic.hasDraftText(''), false);
  assert.equal(logic.hasDraftText('  \n '), false);
  assert.equal(logic.hasDraftText('a'), true);
  assert.equal(logic.hasDraftText(undefined), false);
});

test('buildCommentItemHtml: 投稿者ごとのアイコン付き吹き出しを安全に組み立てる', () => {
  const codex = logic.buildCommentItemHtml({ id: 1, body: '確認しました', createdAt: '2026-10-22T06:05:00.000Z', createdBy: 'codex' });
  assert.match(codex, /class="comment-avatar(?:\s|\")/);
  assert.match(codex, /comment-avatar-ai/);
  assert.match(codex, /comment-avatar-codex/);
  assert.match(codex, /src="codex-icon\.svg"/);
  assert.match(codex, /<span class="comment-item-author">Codex<\/span>/);
  assert.match(codex, /class="comment-bubble"/);

  const user = logic.buildCommentItemHtml({ id: 2, body: '<b>確認</b>', createdAt: '2026-10-22T06:05:00.000Z', createdBy: 'user' });
  assert.match(user, /material-icon icon-person/);
  assert.match(user, /class="comment-item comment-item-user"/);
  assert.ok(!user.includes('comment-avatar-ai'));
  assert.match(user, /<span class="comment-item-author">ユーザー<\/span>/);
  assert.ok(!user.includes('<b>確認</b>'));

  const other = logic.buildCommentItemHtml({ id: 3, body: '確認', createdAt: '2026-10-22T06:05:00.000Z', createdBy: 'other-agent' });
  assert.match(other, /material-icon icon-person/);
  assert.match(other, /<span class="comment-item-author">other-agent<\/span>/);

  const claude = logic.buildCommentItemHtml({ id: 4, body: '確認', createdAt: '2026-10-22T06:05:00.000Z', createdBy: 'claude-code' });
  const kiro = logic.buildCommentItemHtml({ id: 5, body: '確認', createdAt: '2026-10-22T06:05:00.000Z', createdBy: 'kiro' });
  assert.match(claude, /comment-avatar-claude/);
  assert.match(kiro, /comment-avatar-kiro/);
});

test('buildCommentSectionHtml: 見出し・入力欄・一覧(読み込み中/空/あり)を組み立て、値はエスケープする', () => {
  const comments = [
    { id: 2, body: '新しい<script>', createdAt: '2026-10-22T06:05:00.000Z', createdBy: 'kiro' },
    { id: 1, body: '古い', createdAt: '2026-10-21T01:00:00.000Z', createdBy: 'user' },
  ];
  const html = logic.buildCommentSectionHtml({ taskId: 'BM-136', comments, variant: 'modal' });
  assert.match(html, /data-task-id="BM-136"/);
  assert.match(html, /class="comment-count">2</);
  assert.match(html, /class="comment-toggle-btn"[^>]*aria-expanded="true"/);
  assert.match(html, /class="comment-toggle-label">折り畳む/);
  assert.match(html, /<textarea class="comment-input"[^>]*maxlength="1000"/);
  assert.match(html, /class="comment-submit-btn" disabled/, '最初は空なので投稿ボタンは押せない');
  assert.ok(html.indexOf('新しい&lt;script&gt;') < html.indexOf('古い'), '新しい順のまま描く');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /data-comment-id="2"/);
  assert.match(html, /2026-10-22 15:05/);

  assert.match(logic.buildCommentSectionHtml({ taskId: 'BM-1', comments: null, count: 3, variant: 'tip' }), /comment-loading/);
  const empty = logic.buildCommentSectionHtml({ taskId: 'BM-1', comments: [], variant: 'tip' });
  assert.match(empty, /comment-empty/);
  assert.match(empty, /class="comment-count"><\/span>/, '0件の時は件数を出さない');
  assert.match(logic.buildCommentSectionHtml({ taskId: 'a"b', comments: [], variant: 'modal' }), /data-task-id="a&quot;b"/);
});

test('画面の配線: スクリプトの読み込み順、カード・TIP・詳細モーダル・再描画対策、アイコン、スタイル', () => {
  const html = read('index.html');
  const app = read('app.js');
  const comments = read('comments.js');
  const css = read('style.css');
  const has = (src, text) => assert.ok(src.includes(text), `${text} が見つからない`);

  assert.ok(html.indexOf('<script src="comment-logic.js">') < html.indexOf('<script src="app.js">'), 'app.jsがcommentLogicを使うので先に読み込む');
  assert.ok(html.indexOf('<script src="app.js">') < html.indexOf('<script src="comments.js">'), 'app.jsのヘルパーに依存するので後に読み込む');

  // カード: 1行表示(コンパクトは除く)とホバーのコメントボタン(本体+EPICミニボードの子カード)
  has(app, 'const commentLineHtml = commentLogic.buildCardCommentHtml(item.latestComment);');
  assert.ok(!app.includes("commentLineHtml = isCompact ? ''"), '完了カラム(compact)にも最新コメントを出す');
  assert.match(css, /\.card-compact \.card-comment\s*\{[^}]*font-size:\s*var\(--fs-c-tag/, 'compactはcompact用の文字サイズ変数に連動する');
  // BM-162: コメントボタンは右下の操作列(buildCardCornerHtml)に移り、本体カードと子カードで共通の1か所で作る
  assert.equal((app.match(/class="card-corner-btn card-comment-btn"/g) || []).length, 1, '右下の操作列の1か所(本体カードと子カードで共通)');
  assert.ok(!/class="card-action-btn card-comment-btn"/.test(app), '右上のツールバーには置かない');
  assert.equal((app.match(/buildCardCornerHtml\(/g) || []).length, 3, '定義1+本体カード1+子カード1');
  has(app, 'openCardCommentTip(btn)');
  has(app, 'openCardCommentTip(childCommentBtnEl)');
  // 鉛筆ボタン: 詳細モーダルではなく、右クリックTIPを編集モードで開く
  has(app, 'openCardEditTip(btn)');
  has(app, 'openCardEditTip(childEditTipBtnEl)');
  has(app, 'if (editMode) enterTaskQuickTipEditMode(tip, item);');

  // 右クリックTIP: コメント欄、開く処理の共通化、フォーカス
  has(app, "buildTaskCommentSectionHtml(item, 'tip')");
  has(app, 'function openTaskQuickTip(item, x, y, { focusComment = false, editMode = false } = {})');
  has(app, 'if (focusComment) focusCommentInput(tip);');

  // 詳細モーダル: 情報の下・成果物の上(スクロール側カラムの先頭)に置く。本体と子の2か所
  assert.equal((app.match(/commentHtml \+ artifactsHtml/g) || []).length, 2);
  assert.equal((app.match(/hydrateCommentSections\(body, item\)/g) || []).length, 2);

  // 入力中の文字を守る
  has(app, 'if (hasCommentDraft(modalEl)) return;');
  has(app, 'if (hasCommentDraft(el)) return;');
  has(app, 'hasCommentDraft(taskQuickTipEl)');
  has(app, 'hasCommentDraft(el)');
  has(app, 'if (performance.now() < taskQuickTipScrollSuppressUntil) return;');
  assert.ok((app.match(/suppressQuickTipScrollClose\(\)/g) || []).length >= 4, 'ボード・計画ボード・詳細2種の再描画で呼ぶ');

  // 通信とイベント委譲
  has(comments, '/api/task-comments?taskId=');
  has(comments, '/api/add-task-comment');
  has(comments, '/api/delete-task-comment');
  has(comments, "e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.isComposing");
  has(comments, 'if (!btn.classList.contains(\'confirming\'))');
  has(comments, "const toggleBtn = e.target.closest('.comment-toggle-btn');");
  has(comments, "section.classList.toggle('comment-list-collapsed')");

  // アイコンとスタイル
  assert.ok(fs.existsSync(path.join(publicDir, 'icons', 'chat_bubble.svg')));
  assert.ok(fs.existsSync(path.join(publicDir, 'icons', 'add_comment.svg')));
  has(css, ".material-icon.icon-chat-bubble");
  has(css, ".material-icon.icon-add-comment");
  has(css, '.card-comment-text');
  assert.match(css, /\.card-comment-text\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/, '1行で省略記号');
  has(css, '.comment-input');
  has(css, '.comment-section-heading');
  has(css, '.comment-list-collapsed .comment-list-wrap');
  has(css, '.comment-avatar');
  has(css, '.comment-avatar-claude');
  has(css, '.comment-avatar-kiro');
  has(css, '.comment-avatar-codex');
  has(css, '.comment-avatar-codex .comment-avatar-image');
  has(css, '.comment-bubble');
  has(css, '.comment-item-user');
  has(css, 'flex-direction: row-reverse');
  has(css, '.task-quick-tip .comment-list-wrap');
});
