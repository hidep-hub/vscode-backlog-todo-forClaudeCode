// BM-091: ヘッダーミニヒートマップの起動時ウェルカムメッセージ用Web Worker。
// header-heatmap-worker.jsと同じ型: 重い計算(文字のドット展開・フレームごとの点灯セル計算・
// フレーム送出タイマー)はここで行い、メインスレッドには「このフレームで点灯させるセル一覧」
// という小さな配列だけをpostMessageで渡す。メインスレッドはSVGの組み立てとDOM差し込みだけを行う。
importScripts('header-heatmap-font.js');

let timer = null;

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'stop') { stop(); return; }
  if (msg.type !== 'start') return;

  stop();
  const { seq, text, weeks, intervalMs } = msg;
  const strip = self.headerHeatmapFont.textToColumns(text);
  const totalFrames = self.headerHeatmapFont.computeTotalFrames(strip.length, weeks);
  if (totalFrames <= 0) {
    self.postMessage({ type: 'done', seq });
    return;
  }

  let frame = 0;
  const tick = () => {
    const cells = self.headerHeatmapFont.buildIntroFrameCells(strip, weeks, frame);
    self.postMessage({ type: 'frame', seq, frame, totalFrames, cells });
    frame++;
    if (frame >= totalFrames) {
      stop();
      self.postMessage({ type: 'done', seq });
    }
  };
  tick(); // 最初のフレームは即時に送る(intervalMs待たない)
  timer = setInterval(tick, intervalMs);
};
