'use strict';

// BM-163: カード上の外部連携ボタン(GitHub / Redmine)を、各サービスのブランドアイコン1個にまとめた配線を検証する(静的チェック)。
// 画面の動き(メニューの開閉・ダイアログへの受け渡し)は、隔離した開発インスタンスとブラウザで確認している。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const publicDir = path.join(__dirname, '..', 'public');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
const has = (src, text) => assert.ok(src.includes(text), `${text} が見つからない`);
const count = (src, re) => (src.match(re) || []).length;

test('カードのGitHubボタンは1個にまとまり、旧の紐づけ/作成ボタンは残っていない', () => {
  // 本体カードと、EPICミニボードの子カードの2か所でブランドアイコンのボタンを作る
  assert.equal(count(app, /class="card-action-btn card-github-btn"/g), 2, '本体カードと子カードの2か所');
  assert.equal(count(app, /class="card-action-btn card-github-btn"[^>]*>\$\{GITHUB_MARK_SVG\}/g), 2, 'アイコンはGitHubのブランドマーク');
  for (const old of ['card-github-link-btn', 'card-github-create-btn', 'card-child-github-link-btn', 'card-child-github-create-btn']) {
    assert.ok(!app.includes(old), `${old} は残さない`);
  }
  // BT-470: 紐づけ済みでも出す(メニューの「解除」を選べるようにするため。紐づける/作成は無効になる)
  assert.ok(!/githubIssueNumber \? `<button class="card-action-btn card-github-btn"/.test(app), 'GitHubボタンは紐づけ済みでも隠さない');
});

test('Redmineボタンは本体・子とも同じクラスの1個で、メニュー(紐づける/解除)を開く', () => {
  assert.equal(count(app, /class="card-action-btn card-redmine-link-btn"/g), 2, '本体カードと子カードの2か所');
  assert.ok(!app.includes('card-child-redmine-link-btn'), '子専用のクラスは残さない');
  has(app, 'openCardRedmineLink(btn)');
  has(app, 'openCardRedmineLink(childRedmineLinkBtnEl)');
  has(app, "openCardItsLinkMenu(btn, 'redmine')");
});

test('GitHubメニュー: 紐づけ/作成/解除の3項目で、既存のダイアログを呼ぶ', () => {
  has(app, 'function openGithubLinkMenu(btn)');
  has(app, 'data-act="${en.act}"');
  has(app, "act: 'link'");
  has(app, "act: 'create'");
  has(app, "act: 'unlink'");
  has(app, 'run: () => openGithubLinkModal(item)');
  has(app, 'run: () => openGithubCreateConfirm(item, isChild)');
  has(app, "run: () => openExternalUnlinkConfirm(item, 'github')");
  // 紐づけ済みなら紐づける/作成は無効、未紐づけなら解除は無効(グレイアウト)
  has(app, "label: '既存のIssueと紐づける', disabled: linked");
  has(app, "label: '紐づけを解除', disabled: !linked");
  has(app, 'openGithubLinkMenu(btn)');
  has(app, 'openGithubLinkMenu(childGithubBtnEl)');
  // メニュー内のクリックがカード(詳細を開く・選択トグル)へ伝わらない
  assert.match(app, /function openGithubLinkMenu[\s\S]*?el\.addEventListener\('click', \(e\) => \{\s*e\.stopPropagation\(\);/);
});

test('メニューは期日ピッカーと同じ作法で閉じ、再描画でも宙に浮かない', () => {
  const fn = app.slice(app.indexOf('function openGithubLinkMenu'), app.indexOf('// BM-136: カードのコメントボタン'));
  has(fn, "document.addEventListener('pointerdown', onPointerDown, true)");
  has(fn, "document.addEventListener('keydown', onKeyDown, true)");
  has(fn, "window.addEventListener('resize', closeGithubLinkMenu)");
  has(fn, "window.addEventListener('scroll', onScroll, true)");
  has(fn, 'e.stopImmediatePropagation();'); // Escは背後のモーダルまで閉じない
  has(fn, 'removeEventListener'); // 閉じたらリスナーを外す
  // カードを作り直す時(WebSocket更新)に、アンカーが消えるメニューを先に閉じる
  assert.match(app, /function renderBoard\(data\) \{[\s\S]{0,200}closeGithubLinkMenu\(\);/);
});

test('対象はクリック時にタスクIDから引き直し、子かどうかは親EPICの有無で決める', () => {
  const fn = app.slice(app.indexOf('function resolveCardLinkTarget'), app.indexOf('function openCardRedmineLink'));
  has(fn, 'resolveCardTipItem(btn)');
  has(fn, 'findParentEpicOfChildId(btn.dataset.taskId)');
  has(fn, '!findItemById(btn.dataset.taskId)');
});

test('スタイル: ブランドマークの寸法とメニュー', () => {
  // BM-164でGitLabも同じ寸法ルールに加わった(GitLabの確認は gitlab-link-ui.test.js)
  assert.match(css, /\.card-action-btn \.redmine-mark-icon,\s*\.card-action-btn \.github-mark-icon(,\s*\.card-action-btn \.gitlab-mark-icon)?\s*\{[^}]*width:\s*0\.9em/);
  has(css, '.card-link-menu {');
  assert.match(css, /\.card-link-menu\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*2000/);
  has(css, '.card-link-menu-item:focus-visible');
});
