// BT-382: ヘッダのミニヒートマップ用Web Worker。
// /api/activityの取得・JSONパース・日別集計というメインスレッドを塞ぎうる処理をここで行い、
// メインスレッドには「プロジェクト→日付→件数」の小さなオブジェクトだけを返す(ボード操作を妨げない)。
importScripts('header-heatmap.js');

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type !== 'load') return;
  try {
    const res = await fetch('/api/activity');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const events = await res.json();
    self.postMessage({ type: 'counts', seq: msg.seq, byProject: self.headerHeatmap.buildDailyCountsByProject(events) });
  } catch (err) {
    self.postMessage({ type: 'error', seq: msg.seq, message: String(err && err.message || err) });
  }
};
