(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.dueTrail = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 期日の変更履歴(BT-336)の経緯組み立て(BT-435)。DOM操作はapp.js側に置き、ここはnode --testで
  // 単体テストできるよう純粋関数だけにする(tag-logic.jsと同じ構成)。

  // 期日どうしの向きを返す。'later'=延期(未来方向)、'earlier'=前倒し、null=比較不能/同日。
  // 期日はYYYY-MM-DD形式なので文字列比較で足りる。どちらかが未設定なら向きは付けない。
  function dueDirection(from, to) {
    if (!from || !to || from === to) return null;
    return to > from ? 'later' : 'earlier';
  }

  // dueDateHistory([{from,to,at}]古い順)から、当初→現在の経緯を古い順で返す。
  // 各要素は {value, at, direction}。当初値は at/direction がnull。先頭の「未設定」は経緯に含めない。
  function buildDueTrail(history) {
    if (!history || history.length === 0) return [];
    const entries = [{ value: history[0].from || '', at: null, direction: null }];
    let prev = history[0].from || '';
    for (const h of history) {
      entries.push({ value: h.to || '', at: h.at || null, direction: dueDirection(prev, h.to) });
      prev = h.to || '';
    }
    while (entries.length > 0 && !entries[0].value) entries.shift();
    return entries;
  }

  const DIRECTION_CLASS = { later: 'due-postponed', earlier: 'due-advanced' };

  function directionClass(direction) {
    return DIRECTION_CLASS[direction] || '';
  }

  return { dueDirection, buildDueTrail, directionClass };
});
