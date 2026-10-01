(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.headerTicker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // BM-020: ヘッダーのティッカー表示用ロジック。DOM操作そのものはapp.js側に残し、
  // ここは「サーバーの生イベント配列(buildRecentEvents()相当)→表示用の行データ」
  // という純粋関数だけを置く(running-agent-order.jsと同じ構成に揃え、
  // node --testでDOM無しに単体テストできるようにする)。

  const EVENT_ACTION_LABEL = {
    created: 'Create',
    status_changed: 'Update',
    pinned: 'Pin',
    unpinned: 'Unpin',
    running_started: 'Run',
    running_stopped: 'Stop',
    assigned: 'Assign',
    deleted: 'Delete',
  };

  // status_changedのnewValueはstatuses.code('todo'/'ready'/'do'/'done')。
  // コンソール表示では「doneになった」等が分かるcode→表示用ラベルに変換する。
  const STATUS_CODE_LABEL = { todo: 'TODO', ready: 'READY', do: 'DO', done: 'DONE' };

  /**
   * occurredAt(UTCのISO文字列)を 'HH:MM:SS' のローカル時刻文字列に変換する。
   * @param {string} occurredAt
   */
  function formatTime(occurredAt) {
    const d = new Date(occurredAt);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /**
   * 1件のイベント行を「アクション語(例: Run/Update)」と「詳細(例: (DO→DONE))」に分けて返す。
   * アクション語だけを太字強調したいためformatSummaryから分離した(BM-020フィードバック:
   * 「RUNやStopの文字をもっと太くしたい」)。
   * @param {object} ev - buildRecentEvents()が返す1件
   */
  function formatActionDetail(ev) {
    const action = EVENT_ACTION_LABEL[ev.eventType] || ev.eventLabel || ev.eventType;
    if (ev.eventType === 'status_changed') {
      const from = STATUS_CODE_LABEL[ev.oldValue] || ev.oldValue || '?';
      const to = STATUS_CODE_LABEL[ev.newValue] || ev.newValue || '?';
      return { action, detail: `(${from}→${to})` };
    }
    if (ev.eventType === 'assigned') {
      const to = ev.newValue || '(未設定)';
      return { action, detail: `→ ${to}` };
    }
    return { action, detail: '' };
  }

  /**
   * 1件のイベント行の人間向けサマリを作る(例: "Update (DO→DONE)")。
   * formatActionDetail()の結合版(既存呼び出し元/テストとの後方互換用)。
   * @param {object} ev - buildRecentEvents()が返す1件
   */
  function formatSummary(ev) {
    const { action, detail } = formatActionDetail(ev);
    return detail ? `${action} ${detail}` : action;
  }

  /**
   * サーバーの生イベント配列を、ティッカー描画用の行データ配列に変換する。
   * 入力はoccurred_at降順(id降順)を前提とする(buildRecentEventsの返却順)。
   * action/detailを分けて返すのは、描画側でactionだけ太字にするため。
   * @param {Array<object>} events
   * @returns {Array<{id:number, time:string, taskId:string, action:string, detail:string, summary:string, title:string}>}
   */
  function toTickerLines(events) {
    if (!Array.isArray(events)) return [];
    return events.map(ev => {
      const { action, detail } = formatActionDetail(ev);
      return {
        id: ev.id,
        time: formatTime(ev.occurredAt),
        taskId: ev.taskId,
        action,
        detail,
        summary: detail ? `${action} ${detail}` : action,
        title: ev.taskTitle || '',
      };
    });
  }

  return { formatTime, formatSummary, formatActionDetail, toTickerLines };
});
