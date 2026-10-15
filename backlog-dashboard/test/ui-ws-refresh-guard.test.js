'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// BM-089: WebSocket再描画(他タスク/他ワークスペースでの操作によるbroadcast)が、
// 詳細モーダルを読んでいる最中・編集中のユーザー操作を壊さないことを保証する静的検証。
// 実ブラウザでの再現確認はPlaywrightで別途実施済み(タスク説明欄に記録)。

const publicDir = path.join(__dirname, '..', 'public');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

test('説明欄「もっと見る」の展開状態は、WS再描画(renderModalContent/openChildModal)の前後で保存・復元される', () => {
  // setupDescriptionToggleがexpandedオプションを受け取り、呼び出し元に展開状態を復元できる
  assert.match(app, /function setupDescriptionToggle\(container, \{ expanded = false \} = \{\}\)/);

  // 親タスク詳細(renderModalContent)・子タスク詳細(openChildModal)の両方で、
  // 再描画前に現在の展開状態(.description-collapsible.expanded)を読み取ってから
  // setupDescriptionToggleへ渡している
  const prevDescExpandedCount = (app.match(/const prevDescExpanded = !!body\.querySelector\('\.description-collapsible\.expanded'\);/g) || []).length;
  assert.equal(prevDescExpandedCount, 2, 'renderModalContentとopenChildModalの両方で展開状態を保存しているはず');

  const restoreCallCount = (app.match(/setupDescriptionToggle\(body, \{ expanded: prevDescExpanded \}\);/g) || []).length;
  assert.equal(restoreCallCount, 2, 'renderModalContent/openChildModalの両方で復元しているはず');
});

test('親タスク詳細モーダルは、編集フォーム表示中はWS再描画(refreshModalIfOpen)をスキップする(子モーダルのBT-366と同じガード)', () => {
  assert.match(
    app,
    /function refreshModalIfOpen\(\) \{\s*refreshChildModalIfOpen\(\);\s*if \(!currentModalItemId \|\| !modalEl \|\| !modalEl\.classList\.contains\('modal-visible'\)\) return;\s*if \(modalEl\.querySelector\('#edit-task-title'\)\) return;/,
  );
});

test('子タスク詳細モーダルも同様に編集フォーム表示中はWS再描画をスキップする(既存のBT-366対策が維持されている)', () => {
  assert.match(
    app,
    /function refreshChildModalIfOpen\(\) \{[\s\S]*?if \(el\.querySelector\('#edit-task-title'\)\) return;/,
  );
});
