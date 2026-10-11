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
  assert.ok(html.indexOf('tag-logic.js') < html.indexOf('tags.js'), 'ロジックを先に読み込む');
  assert.ok(html.indexOf('app.js') < html.indexOf('tags.js'), 'app.jsのヘルパーに依存するので後に読み込む');
  assert.ok(fs.existsSync(path.join(publicDir, 'icons', 'local_offer.svg')));
  assert.match(css, /\.material-icon\.icon-tag\s*\{[^}]*icons\/local_offer\.svg/);
});

test('タグモーダルは最前面判定(Escape制御)の対象に含まれ、旧サーバー向けの案内を持つ', () => {
  assert.match(app, /\.tag-modal-overlay\.modal-visible/);
  assert.match(tagsJs, /isTopmostDialog\(tagModalEl\)/);
  assert.match(tagsJs, /サーバーを最新版へ再起動/);
  assert.match(tagsJs, /confirmSimilar/);
});
