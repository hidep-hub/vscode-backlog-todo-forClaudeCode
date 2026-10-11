(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.tagLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // タグ管理画面(BT-394)の純粋ロジック。DOM操作はtags.js側に置き、ここはnode --testで
  // 単体テストできるよう関数だけにする(header-ticker.jsと同じ構成)。
  // 正規化規則はdb/tags-repo.jsのcleanName/toNameKeyと揃える(サーバーが最終判定するため、
  // こちらは入力中のヒント・事前チェック用)。

  /** 表示用の整形: NFKC・連続空白の圧縮・trim。 */
  function cleanTagName(name) {
    return String(name == null ? '' : name).normalize('NFKC').replace(/\s+/g, ' ').trim();
  }

  /** 重複判定キー(サーバーのname_keyと同じ)。 */
  function tagNameKey(name) {
    return cleanTagName(name).toLowerCase();
  }

  /** 名前が完全一致(表記ゆれ込み)する既存タグを返す。excludeIdは改名時の自分自身の除外用。 */
  function findExactTag(tags, name, excludeId = null) {
    const key = tagNameKey(name);
    if (!key) return null;
    return tags.find(t => t.id !== excludeId && tagNameKey(t.name) === key) || null;
  }

  /** 色の上に載せる文字色(黒/白)。#rrggbbのYIQ輝度で決める。色なし・不正値はnull。 */
  function readableTextColor(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const yiq = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
    return yiq >= 150 ? '#1a1a1a' : '#ffffff';
  }

  function buildDeleteMessage(tag) {
    const used = tag.usageCount || 0;
    return used > 0
      ? `タグ「${tag.name}」を削除します。付いている ${used} 件のタスクからも外れます。元に戻せません。よろしいですか？`
      : `タグ「${tag.name}」を削除します。元に戻せません。よろしいですか？`;
  }

  function buildMergeMessage(source, target) {
    const used = source.usageCount || 0;
    return `タグ「${source.name}」を「${target.name}」に統合します。`
      + (used > 0 ? `「${source.name}」が付いている ${used} 件のタスクは「${target.name}」に付け替わります。` : '')
      + `「${source.name}」は削除され、元に戻せません。よろしいですか？`;
  }

  /**
   * サーバーのタグAPIエラー(body)を、画面に出す日本語メッセージとヒント情報に変換する。
   * similar_tags は「似たタグがある」ことを伝え、確認のうえ作成を続けられるようにする。
   * @returns {{kind:string, message:string, similar?:Array, existing?:object}}
   */
  function describeTagError(body) {
    const b = body || {};
    switch (b.error) {
      case 'duplicate_tag':
        return { kind: 'duplicate', message: `同じ名前のタグが既にあります: ${b.existing ? b.existing.name : ''}`, existing: b.existing };
      case 'similar_tags':
        return {
          kind: 'similar',
          message: `似た名前のタグがあります: ${(b.similar || []).map(t => t.name).join('、')}`,
          similar: b.similar || [],
        };
      default:
        return { kind: 'error', message: b.message || b.error || '不明なエラー' };
    }
  }

  return { cleanTagName, tagNameKey, findExactTag, readableTextColor, buildDeleteMessage, buildMergeMessage, describeTagError };
});
