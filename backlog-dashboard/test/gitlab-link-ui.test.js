'use strict';

// BM-164: GitLab issueの紐づけ導線(カード・詳細モーダル)と、Redmine/GitLab共通の紐づけダイアログへのまとめを検証する(静的チェック)。
// サーバー側(its-link-api.js)の振る舞いは test/its-link-api.test.js、画面の動きは隔離した開発インスタンスで確認している。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const publicDir = path.join(__dirname, '..', 'public');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
const has = (src, text) => assert.ok(src.includes(text), `${text} が見つからない`);
const count = (src, re) => (src.match(re) || []).length;

test('カードのGitLabボタン: 本体・子カードとも、ブランドアイコン1個でメニューを挟まず紐づけを開く', () => {
  assert.equal(count(app, /class="card-action-btn card-gitlab-link-btn"[^>]*>\$\{GITLAB_MARK_SVG\}/g), 2, '本体カードと子カードの2か所');
  // GitHubと違い、紐づけ済みでも出す(上書き可。Redmineと同じ)
  assert.ok(!/githubIssueNumber[^`]*card-gitlab-link-btn/.test(app), 'GitLabボタンは紐づけ済みでも隠さない');
  has(app, 'openCardGitlabLink(btn)');
  has(app, 'openCardGitlabLink(childGitlabLinkBtnEl)');
  has(app, 'if (target) openGitlabLinkModal(target.item);');
  // 対象はクリック時にタスクIDから引き直す(Redmine/GitHubと同じ)
  assert.match(app, /function openCardGitlabLink\(btn\) \{\s*const target = resolveCardLinkTarget\(btn\);/);
});

test('GitLabバッジのクリックはカードに伝わらない(これまで漏れていた)', () => {
  has(app, "boardEl.querySelectorAll('.gitlab-issue-badge')");
  has(app, "card.querySelector('.gitlab-issue-badge')");
  assert.equal(count(app, /gitlab-issue-badge'\)[\s\S]{0,160}?stopPropagation/g), 2, 'メインボードと子カードの2か所');
});

test('詳細モーダル: 外部連携グループにGitLabの紐づけボタンがあり、親・子の両方で配線されている', () => {
  assert.equal(count(app, /id="modal-gitlab-link-btn">\$\{GITLAB_MARK_SVG\} 紐づけ</g), 2, '親/単発の詳細と子の詳細の2か所');
  assert.equal(count(app, /actionGroup\('外部連携', githubLinkBtnHtml, githubCreateBtnHtml, redmineLinkBtnHtml, gitlabLinkBtnHtml\)/g), 2);
  assert.equal(count(app, /body\.querySelector\('#modal-gitlab-link-btn'\)/g), 2);
  // クリックでダイアログを開く配線(関数の定義 function openGitlabLinkModal(item) は数えない)
  assert.equal(count(app, /gitlabLinkBtnEl\.addEventListener\('click', \(\) => openGitlabLinkModal\(item\)\)/g), 2);
});

test('紐づけダイアログはRedmineとGitLabで1つに共通化され、旧のRedmine専用は残っていない', () => {
  has(app, 'function openItsLinkModal(item, source)');
  has(app, 'function openRedmineLinkModal(item) { openItsLinkModal(item, \'redmine\'); }');
  has(app, 'function openGitlabLinkModal(item) { openItsLinkModal(item, \'gitlab\'); }');
  for (const old of ['redmine-link-overlay', 'closeRedmineLinkModal', 'getOrCreateRedmineLinkModal', 'parseRedmineIssueKeyInput', 'redmine-link-input', 'redmine-link-ok']) {
    assert.ok(!app.includes(old), `${old} は共通化で残さない`);
  }
  // サービスごとの違いは設定オブジェクトに集める
  const cfg = app.slice(app.indexOf('const ITS_LINK_SOURCES'), app.indexOf('function getOrCreateItsLinkModal'));
  has(cfg, "label: 'Redmine'");
  has(cfg, "label: 'GitLab'");
  has(cfg, "kind: 'チケット'");
  has(cfg, "kind: 'issue'");
  // 送信先はサービス共通のAPIで、sourceを渡す。共有の確認(BM-158)も共通
  const fn = app.slice(app.indexOf('function openItsLinkModal'), app.indexOf('function openRedmineLinkModal'));
  has(fn, "fetch('/api/its-link-issue'");
  has(fn, 'JSON.stringify({ taskId: item.id, source, issueKey');
  has(fn, 'createSharedLinkConfirm(');
  has(fn, "resp.status === 409 && data.error === 'already_linked'");
});

test('URL入力からの番号取り出しは、Redmine(.../issues/12)とGitLab(.../-/issues/12)の両方に使える', () => {
  const src = app.slice(app.indexOf('function parseItsIssueKeyInput'), app.indexOf('/**\n * 外部ITSのチケット紐付けモーダルを開く'));
  // 関数をそのまま取り出して動かす(画面の外でも実際の入力例で確かめる)
  const parse = new Function(`${src}; return parseItsIssueKeyInput;`)();
  assert.equal(parse('12'), '12');
  assert.equal(parse('#12'), '12');
  assert.equal(parse('  #12  '), '12');
  assert.equal(parse('https://redmine.example.com/issues/123'), '123');
  assert.equal(parse('https://gitlab.example.com/group/project/-/issues/12'), '12');
  assert.equal(parse('https://gitlab.example.com/group/sub/project/-/issues/7?foo=1'), '7');
  assert.equal(parse(''), '');
  assert.equal(parse(null), '');
  assert.equal(parse('abc'), 'abc', '数字でない入力はそのまま返す(サーバー側で400になる)');
});

test('スタイル: GitLabのブランドマークの寸法がカードのボタンと詳細モーダルのボタンで他のブランドとそろっている', () => {
  assert.match(css, /\.card-action-btn \.redmine-mark-icon,\s*\.card-action-btn \.github-mark-icon,\s*\.card-action-btn \.gitlab-mark-icon\s*\{[^}]*width:\s*0\.9em/);
  assert.match(css, /\.add-child-btn \.github-mark-icon,\s*\.add-child-btn \.redmine-mark-icon,\s*\.add-child-btn \.gitlab-mark-icon\s*\{[^}]*width:\s*0\.85em/);
});
