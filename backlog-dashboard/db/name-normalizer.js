'use strict';

// タグ(BT-393)・カテゴリ(BM-105)で共通する名前の正規化・重複判定ロジック。
// どちらもワークスペース単位の自由入力マスタで、表記ゆれ(全角半角・大小文字・前後空白)を
// 吸収した重複/類似名チェックを行う必要があるため、このモジュールに共通化する。

const MAX_NAME_LENGTH = 40;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function fail(code, message, extra) {
  const err = new Error(message || code);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * 表示用の名前を整える。NFKC正規化(全角英数→半角、半角カナ→全角カナ等)・連続空白の圧縮・前後trim。
 * 大文字小文字は表示のため保持する。
 */
function cleanName(name) {
  if (typeof name !== 'string') throw fail('invalid_name', '名前は文字列で指定してください');
  const cleaned = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!cleaned) throw fail('invalid_name', '名前が空です');
  if ([...cleaned].length > MAX_NAME_LENGTH) throw fail('invalid_name', `名前は${MAX_NAME_LENGTH}文字以内にしてください`);
  return cleaned;
}

/** 重複判定用キー。cleanName後の文字列を小文字化する。 */
function toNameKey(cleanedName) {
  return cleanedName.toLowerCase();
}

function normalizeColor(color) {
  if (color === undefined || color === null || color === '') return null;
  if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) {
    throw fail('invalid_color', 'colorは#rrggbb形式で指定してください');
  }
  return color.toLowerCase();
}

function levenshtein(a, b) {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

// 片方がもう片方を含む(2文字以上)か、4文字以上で編集距離1以内なら「似ている」とみなす。
function isSimilarKey(a, b) {
  const shorter = Math.min([...a].length, [...b].length);
  if (shorter >= 2 && (a.includes(b) || b.includes(a))) return true;
  return shorter >= 4 && levenshtein(a, b) <= 1;
}

module.exports = { fail, cleanName, toNameKey, normalizeColor, isSimilarKey, levenshtein, MAX_NAME_LENGTH };
