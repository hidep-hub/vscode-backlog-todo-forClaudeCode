(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.commentLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // タスクコメント(BM-136)の純粋ロジック。DOM操作・通信はcomments.js側に置き、ここはnode --testで
  // 単体テストできるよう関数だけにする(tag-logic.jsと同じ構成)。

  const MAX_LENGTH = 1000; // サーバー(db/comments-repo.js MAX_BODY_LENGTH)と揃える。最終判定はサーバー
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const COMMENT_AGENT_META = {
    codex: { label: 'Codex', icon: 'codex-icon.svg', avatarClass: 'comment-avatar-codex' },
    'claude-code': { label: 'Claude Code', icon: 'claude-icon.png', avatarClass: 'comment-avatar-claude' },
    kiro: { label: 'Kiro', icon: 'kiro-run-icon.png', avatarClass: 'comment-avatar-kiro' },
    user: { label: 'ユーザー', icon: null },
  };

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  // ISO文字列をJSTの壁時計に分解する。解釈できなければnull。
  function jstParts(iso) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return null;
    const d = new Date(ms + JST_OFFSET_MS);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
  }

  /** カードの1行表示用の日付。今年は "10/22"、他の年は "2025/12/30"(JST)。 */
  function formatCommentDate(iso, now = new Date()) {
    const p = jstParts(iso);
    if (!p) return '';
    const thisYear = new Date(now.getTime() + JST_OFFSET_MS).getUTCFullYear();
    return p.y === thisYear ? `${pad2(p.m)}/${pad2(p.d)}` : `${p.y}/${pad2(p.m)}/${pad2(p.d)}`;
  }

  /** 一覧用の日時 "2026-10-22 15:30"(JST)。 */
  function formatCommentDateTime(iso) {
    const p = jstParts(iso);
    return p ? `${p.y}-${pad2(p.m)}-${pad2(p.d)} ${pad2(p.hh)}:${pad2(p.mm)}` : '';
  }

  /** 本文の先頭の空でない行。カードには1行だけ出す。 */
  function firstLine(body) {
    const lines = String(body == null ? '' : body).split('\n').map(line => line.trim());
    return lines.find(line => line !== '') || '';
  }

  /** コメント投稿者の表示情報。登録済みAI以外はユーザーアイコンで安全に表示する。 */
  function commentAgentMeta(actor) {
    return COMMENT_AGENT_META[actor] || { label: actor || 'ユーザー', icon: null };
  }

  function buildCommentAuthorHtml(actor) {
    const meta = commentAgentMeta(actor);
    const avatar = meta.icon
      ? `<img class="comment-avatar-image" src="${escapeText(meta.icon)}" alt="" aria-hidden="true">`
      : '<span class="material-icon icon-person" aria-hidden="true"></span>';
    return `<span class="comment-avatar${meta.icon ? ' comment-avatar-ai' : ''}${meta.avatarClass ? ` ${meta.avatarClass}` : ''}" title="${escapeText(meta.label)}">${avatar}</span>`;
  }

  /**
   * カードに出す1行コメント。latest(最新1件)が無ければ空文字(コメントなしのカードは高さを変えない)。
   * 長い分はCSSの省略記号で切る。ツールチップには日時・投稿者・最新コメントの本文(先頭120文字)を出す。
   */
  function buildCardCommentHtml(latest, now = new Date()) {
    if (!latest || typeof latest.body !== 'string') return '';
    const text = firstLine(latest.body);
    if (!text) return '';
    const tip = `${formatCommentDateTime(latest.createdAt)} ${latest.createdBy || ''}\n${latest.body}`.trim();
    return `<div class="card-comment" title="${escapeText(tip)}">`
      + '<span class="material-icon icon-chat-bubble"></span>'
      + `<span class="card-comment-date">${escapeText(formatCommentDate(latest.createdAt, now))}</span>`
      + `<span class="card-comment-text">${escapeText(text)}</span></div>`;
  }

  /**
   * 表示に使うコメント一覧と、再取得が要るかを決める。
   * 優先順: 件数0なら空 → 件数が合うキャッシュ → 件数が合う詳細itemのcomments → 古いキャッシュ(再取得する) → 未取得。
   * キャッシュは投稿・削除の直後に更新しているので、最新の状態を保てる。
   * @returns {{comments: Array|null, needsFetch: boolean}} commentsがnullなら読み込み中
   */
  function resolveComments(item, cached) {
    const count = item && typeof item.commentCount === 'number' ? item.commentCount : null;
    if (count === 0) return { comments: [], needsFetch: false };
    if (Array.isArray(cached) && (count === null || cached.length === count)) return { comments: cached, needsFetch: false };
    if (item && Array.isArray(item.comments) && (count === null || item.comments.length === count)) {
      return { comments: item.comments, needsFetch: false };
    }
    if (Array.isArray(cached)) return { comments: cached, needsFetch: true };
    return { comments: null, needsFetch: true };
  }

  function buildCommentItemHtml(comment) {
    const isUser = comment.createdBy === 'user';
    return `<li class="comment-item${isUser ? ' comment-item-user' : ''}" data-comment-id="${escapeText(comment.id)}">`
      + buildCommentAuthorHtml(comment.createdBy)
      + '<div class="comment-bubble">'
      + '<div class="comment-item-meta">'
      + `<span class="comment-item-author">${escapeText(commentAgentMeta(comment.createdBy).label)}</span>`
      + `<span class="comment-item-time">${escapeText(formatCommentDateTime(comment.createdAt))}</span>`
      + `<button type="button" class="comment-delete-btn" data-comment-id="${escapeText(comment.id)}" title="このコメントを削除" aria-label="このコメントを削除"><span class="material-icon icon-delete"></span></button>`
      + '</div>'
      + `<div class="comment-item-body">${escapeText(comment.body)}</div></div></li>`;
  }

  /** 一覧部分のHTML。nullは読み込み中、空配列はコメントなし。 */
  function buildCommentListInnerHtml(comments) {
    if (comments === null || comments === undefined) return '<div class="comment-loading">読み込み中...</div>';
    if (comments.length === 0) return '<div class="comment-empty">まだコメントはないよ</div>';
    return `<ul class="comment-list">${comments.map(buildCommentItemHtml).join('')}</ul>`;
  }

  /** 入力欄が空かどうか(空白だけも空とみなす)。投稿ボタンの活性と、未保存ガードに使う。 */
  function hasDraftText(value) {
    return typeof value === 'string' && value.trim() !== '';
  }

  /**
   * コメント欄(見出し・入力欄・一覧)のHTML。variantは 'modal'(詳細) / 'tip'(右クリックTIP)。
   * 一覧だけを差し替えられるよう、一覧は .comment-list-wrap にまとめる(入力中の文字を壊さないため)。
   */
  function buildCommentSectionHtml({ taskId, comments, count, variant }) {
    const n = Array.isArray(comments) ? comments.length : (typeof count === 'number' ? count : 0);
    return `<div class="detail-section comment-section comment-section-${escapeText(variant)}" data-task-id="${escapeText(taskId)}" data-variant="${escapeText(variant)}">`
      + `<div class="comment-section-heading"><h4>コメント <span class="comment-count">${n > 0 ? n : ''}</span></h4>`
      + '<button type="button" class="comment-toggle-btn" aria-expanded="true" title="コメント一覧を折り畳む"><span class="material-icon icon-arrow-forward comment-toggle-icon"></span><span class="comment-toggle-label">折り畳む</span></button></div>'
      + '<div class="comment-form">'
      + `<textarea class="comment-input" rows="2" maxlength="${MAX_LENGTH}" placeholder="状況をひとこと（Ctrl+Enterで投稿）" aria-label="コメントを入力"></textarea>`
      + '<div class="comment-form-actions">'
      + '<span class="comment-error" role="alert" hidden></span>'
      + '<button type="button" class="comment-submit-btn" disabled>投稿</button>'
      + '</div></div>'
      + `<div class="comment-list-wrap">${buildCommentListInnerHtml(comments)}</div></div>`;
  }

  return {
    MAX_LENGTH, escapeText, formatCommentDate, formatCommentDateTime, firstLine,
    commentAgentMeta, buildCommentAuthorHtml, buildCardCommentHtml, resolveComments, buildCommentItemHtml, buildCommentListInnerHtml,
    hasDraftText, buildCommentSectionHtml,
  };
});
