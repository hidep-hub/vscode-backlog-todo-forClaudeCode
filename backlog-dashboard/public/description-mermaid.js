// 説明欄のMarkdown内の ```mermaid ブロックを図として描画する(BM-145)。
//
// 役割分担:
//  - app.js の共通レンダラ(renderDescriptionMarkdown)が、mermaidブロックを renderMermaidBlockHtml() に渡して
//    図の置き場(.mermaid-block)のHTMLにする。入力欄のプレビュー・詳細モーダル・検索ペイン・右クリックTIPで共通
//  - ここでは、置き場がDOMに入ったのをMutationObserverで見つけて、mermaid本体を読み込んでSVGに差し替える
//    (呼び出し側の4か所には手を入れない)
//
// 設計上の約束:
//  - mermaid.min.js(約5.5MB)は、最初のmermaidブロックが画面に出た時にだけ読み込む(普段の起動は重くしない)
//  - securityLevel は strict 固定。説明欄にはAIや外部ITSの取り込み文も入るため、図の中のHTMLやクリックイベントを許さない
//  - 描画済みSVGは「テーマ+ソース」をキーにキャッシュする。WebSocketの再描画で説明欄が作り直されても、
//    キャッシュがあれば最初から図を入れた状態で返すので、チラつかない
//  - 構文エラー時は、エラー文と元のコードを出す(図が出ないだけで説明欄の他の部分は壊さない)
//  - Light/Darkの切替(<html data-theme>)に合わせて、描画済みの図を新しいテーマで描き直す

const DESC_MERMAID_SRC = 'vendor/mermaid.min.js';
const DESC_MERMAID_CACHE_MAX = 60;

// key: `${theme}\n${source}` -> { svg, id }。Mapの挿入順を使って、古いものから捨てる
const descMermaidCache = new Map();
let descMermaidLoadPromise = null;
let descMermaidQueue = Promise.resolve();
let descMermaidConfiguredTheme = null;
let descMermaidSeq = 0;
let descMermaidScanScheduled = false;

// 画面のLight/Darkに対応するmermaidのテーマ名。applyPaletteが <html data-theme="light|dark"> を設定する
function descMermaidTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'default' : 'dark';
}

// 属性値・テキストの両方に使えるエスケープ。app.jsのescapeHtmlは引用符を変換しないため、属性に入れる用に別で持つ
function descMermaidEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 同じ図を複数の場所(モーダルとTIPなど)に同時に出すと、SVG内のid(矢じりのmarker等)が重複する。
// 非表示側のSVGにmarkerが残ると矢じりが消えることがあるため、挿入のたびにid接頭辞を付け替える
function descMermaidUniqueSvg(entry) {
  const id = `bm145-mmd-${++descMermaidSeq}`;
  return entry.svg.split(entry.id).join(id);
}

// --- 描画結果SVGの無害化 ---
// mermaidは securityLevel:'strict' でも、(1)ラベル内の<img>、(2)図のソース先頭の %%{init: {"themeCSS": "...url(...)"}}%% などの
// CSSのurl() を通す。そのまま表示すると、説明欄(外部ITSから取り込んだ文も入る)を開いただけで、任意のURLへリクエストが飛ぶ。
// 説明欄の「画像は無効化」という既存方針に合わせて、外部を参照する要素・属性・CSSを描画結果から取り除く。
const DESC_MERMAID_DROP_TAGS = 'script,iframe,frame,object,embed,img,image,picture,source,video,audio,track,link,meta,base,form,input,button,textarea,select';

// CSSから外部参照を取り除く。url(#id)(同一SVG内のmarker等)は残し、それ以外のurl()は none にする。@import は削除する
function descMermaidScrubCss(css) {
  return String(css)
    .replace(/@import[^;{]*;?/gi, '')
    .replace(/url\(\s*(?:"(?!#)[^"]*"|'(?!#)[^']*'|(?!["'#])[^)]*)\s*\)/gi, 'none');
}

function descMermaidSanitizeSvg(svgText) {
  const tpl = document.createElement('template'); // templateの中身は不活性なので、無害化の前に画像などが読み込まれない
  tpl.innerHTML = svgText;
  const root = tpl.content;
  const isInlineImage = (el) => /^(img|image)$/.test(el.localName)
    && /^data:image\//i.test((el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('xlink:href') || '').trim());
  root.querySelectorAll(DESC_MERMAID_DROP_TAGS).forEach((el) => { if (!isInlineImage(el)) el.remove(); });
  root.querySelectorAll('style').forEach((el) => { el.textContent = descMermaidScrubCss(el.textContent); });
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (name === 'href' || name === 'xlink:href' || name === 'src' || name === 'poster' || name === 'background') {
        const v = value.trim();
        const allowed = el.localName === 'a'
          ? /^https?:\/\//i.test(v)
          : (v.startsWith('#') || (/^(img|image)$/.test(el.localName) && /^data:image\//i.test(v)));
        if (!allowed) el.removeAttribute(attr.name);
      } else if (/url\(/i.test(value) || /@import/i.test(value)) {
        el.setAttribute(attr.name, descMermaidScrubCss(value));
      }
    }
    if (el.localName === 'a') { // 図の中のリンクで、ダッシュボード自体が別ページに遷移しないようにする(説明欄の通常リンクと同じ)
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return tpl.innerHTML;
}

function descMermaidCacheGet(key) {
  const entry = descMermaidCache.get(key);
  if (!entry) return null;
  descMermaidCache.delete(key);
  descMermaidCache.set(key, entry);
  return entry;
}

function descMermaidCacheSet(key, entry) {
  descMermaidCache.set(key, entry);
  while (descMermaidCache.size > DESC_MERMAID_CACHE_MAX) {
    descMermaidCache.delete(descMermaidCache.keys().next().value);
  }
}

// app.jsの共通レンダラから呼ぶ: mermaidブロックの置き場のHTMLを返す。
// 描画済みのキャッシュがあれば図を入れた状態(done)、なければ元コードを入れた状態(pending)で返し、後で差し替える
function renderMermaidBlockHtml(source) {
  const theme = descMermaidTheme();
  const attrs = `class="mermaid-block" data-mermaid-src="${descMermaidEscape(source)}"`;
  const hit = descMermaidCacheGet(`${theme}\n${source}`);
  if (hit) {
    return `<div ${attrs} data-mermaid-state="done" data-mermaid-theme="${theme}">${descMermaidUniqueSvg(hit)}</div>`;
  }
  return `<div ${attrs} data-mermaid-state="pending"><pre class="mermaid-source"><code>${descMermaidEscape(source)}</code></pre></div>`;
}

function descMermaidLoad() {
  if (typeof mermaid !== 'undefined') return Promise.resolve(mermaid);
  if (!descMermaidLoadPromise) {
    descMermaidLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = DESC_MERMAID_SRC;
      script.onload = () => (typeof mermaid !== 'undefined'
        ? resolve(mermaid)
        : reject(new Error('mermaidを初期化できませんでした')));
      script.onerror = () => {
        descMermaidLoadPromise = null; // 次の機会に再試行できるようにする
        reject(new Error('mermaid.min.js を読み込めませんでした'));
      };
      document.head.appendChild(script);
    });
  }
  return descMermaidLoadPromise;
}

// mermaidのinitialize(テーマ設定)はグローバルなので、描画を1件ずつ直列に流して、テーマの取り違えを防ぐ
function descMermaidRender(source, theme) {
  const key = `${theme}\n${source}`;
  const run = async () => {
    const cached = descMermaidCacheGet(key);
    if (cached) return cached;
    const m = await descMermaidLoad();
    if (descMermaidConfiguredTheme !== theme) {
      m.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme,
        suppressErrorRendering: true,
        // 図のソース先頭の %%{init: ...}%% で、これらを上書きさせない。既定のsecureに、実測で外部CSS(url())を注入できると
        // 確認できた themeCSS と fontFamily、およびラベルの無害化設定(dompurifyConfig)を加えた。
        // themeVariables・flowchart・sequence などは、同じ手順で試して外部参照が出なかったため塞がない(見た目の調整は使える)
        secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
          'themeCSS', 'fontFamily', 'dompurifyConfig'],
        // ラベルのHTMLから、外部を読み込む要素・属性を取り除く(描画の途中の一時DOMにも効かせる)
        dompurifyConfig: {
          FORBID_TAGS: ['img', 'image', 'picture', 'source', 'video', 'audio', 'track', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base', 'style', 'form', 'input', 'button'],
          FORBID_ATTR: ['style', 'src', 'srcset', 'poster', 'background'],
        },
      });
      descMermaidConfiguredTheme = theme;
    }
    const id = `bm145-mmd-r${++descMermaidSeq}`;
    try {
      const { svg } = await m.render(id, source);
      const entry = { svg: descMermaidSanitizeSvg(svg), id };
      descMermaidCacheSet(key, entry);
      return entry;
    } finally {
      // 失敗時にmermaidが一時要素を残すことがあるため片付ける(成功時は既に無いので何も起きない)
      const leftover = document.getElementById(id) || document.getElementById(`d${id}`);
      if (leftover) leftover.remove();
    }
  };
  const promise = descMermaidQueue.then(run, run);
  descMermaidQueue = promise.catch(() => {});
  return promise;
}

// mermaidのエラー文は複数行(位置を示す「^」の行と、期待されるトークンの長いリスト)。
// 画面には「Parse error on line 3:」のような先頭行だけを出し、全文はツールチップに回す
function descMermaidErrorHtml(source, error) {
  const full = String((error && error.message) || error || '不明なエラー').trim();
  const firstLine = full.split(/\r?\n/)[0].slice(0, 200);
  return `<div class="mermaid-error-msg" title="${descMermaidEscape(full.slice(0, 1000))}">⚠ mermaidの図を描画できなかったよ: ${descMermaidEscape(firstLine)}</div>`
    + `<pre class="mermaid-source"><code>${descMermaidEscape(source)}</code></pre>`;
}

// 画面内の「描画待ち(pending)」の置き場を、SVGに差し替える
function descMermaidHydrate() {
  document.querySelectorAll('.mermaid-block[data-mermaid-state="pending"]').forEach((el) => {
    const source = el.dataset.mermaidSrc || '';
    const theme = descMermaidTheme();
    el.dataset.mermaidState = 'rendering';
    descMermaidRender(source, theme).then((entry) => {
      if (!el.isConnected) return; // 描画中に説明欄が作り直された。結果はキャッシュに残るので、新しい置き場は即座に図になる
      el.innerHTML = descMermaidUniqueSvg(entry);
      el.dataset.mermaidTheme = theme;
      el.dataset.mermaidState = 'done';
      // 描画中にテーマが切り替わっていた場合は、新しいテーマで描き直す
      if (theme !== descMermaidTheme()) {
        el.dataset.mermaidState = 'pending';
        descMermaidScheduleScan();
      }
    }).catch((error) => {
      if (!el.isConnected) return;
      el.innerHTML = descMermaidErrorHtml(source, error);
      el.dataset.mermaidState = 'error';
    });
  });
}

function descMermaidScheduleScan() {
  if (descMermaidScanScheduled) return;
  descMermaidScanScheduled = true;
  requestAnimationFrame(() => {
    descMermaidScanScheduled = false;
    descMermaidHydrate();
  });
}

// 置き場がDOMに追加されたら描画を始める。追加されたノードの中だけを調べる(ボード全体の再描画で全走査しない)
new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches('.mermaid-block[data-mermaid-state="pending"]')
        || node.querySelector('.mermaid-block[data-mermaid-state="pending"]')) {
        descMermaidScheduleScan();
        return;
      }
    }
  }
}).observe(document.body, { childList: true, subtree: true });

// Light/Darkの切替: 描画済みの図のうち、今のテーマと違うものを描き直す(新しい図が出来るまで、古い図を表示し続ける)
new MutationObserver(() => {
  const theme = descMermaidTheme();
  let changed = false;
  document.querySelectorAll('.mermaid-block[data-mermaid-state="done"]').forEach((el) => {
    if (el.dataset.mermaidTheme !== theme) {
      el.dataset.mermaidState = 'pending';
      changed = true;
    }
  });
  if (changed) descMermaidScheduleScan();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
