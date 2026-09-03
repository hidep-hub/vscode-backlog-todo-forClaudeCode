'use strict';

// DBまるごとのバックアップ/復元（BT-176）。node:sqliteのserialize()/deserialize()を使う
// （BT-180で動作確認済み）。serialize()の出力はそれ自体が完全なSQLiteファイル実体なので、
// バックアップファイルは他のsqlite3ツールでもそのまま開ける。

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

/**
 * DB接続をまるごとバイナリにシリアライズし、ファイルへ書き出す。
 * SQLiteの仕様上、WALモードのままserialize()すると復元時に開けなくなる
 * （WALは:memory:で扱えないため）。checkpointしてから一時的にDELETEモードへ
 * 切り替えてserializeし、完了後にWALへ戻す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} outPath
 */
function exportDatabase(db, outPath) {
  db.exec('PRAGMA wal_checkpoint(FULL);');
  db.exec('PRAGMA journal_mode = DELETE;');
  try {
    const buffer = db.serialize();
    fs.writeFileSync(outPath, buffer);
    return outPath;
  } finally {
    db.exec('PRAGMA journal_mode = WAL;');
  }
}

/**
 * バックアップファイルからインメモリDB接続を復元して返す。
 * 呼び出し側でファイルへ永続化したい場合は `db.exec("VACUUM INTO '<path>'")` を使う。
 * @param {string} backupPath
 * @returns {import('node:sqlite').DatabaseSync}
 */
function restoreDatabase(backupPath) {
  const buffer = fs.readFileSync(backupPath);
  const db = new DatabaseSync(':memory:');
  db.deserialize(buffer);
  return db;
}

module.exports = { exportDatabase, restoreDatabase };

// CLI実行:
//   node db/export.js export <元DBパス> <出力バックアップパス>
//   node db/export.js restore <バックアップパス> <復元先DBパス>
if (require.main === module) {
  const [, , mode, src, dest] = process.argv;

  if (mode === 'export' && src && dest) {
    // journal_modeの一時切り替えが必要なため読み書き可能で開く
    const db = new DatabaseSync(src);
    try {
      exportDatabase(db, dest);
      console.log(`[export] 完了: ${src} -> ${dest}`);
    } finally {
      db.close();
    }
  } else if (mode === 'restore' && src && dest) {
    if (fs.existsSync(dest)) {
      console.error(`既に存在します（上書き防止のため中断）: ${dest}`);
      process.exit(1);
    }
    const memDb = restoreDatabase(src);
    try {
      memDb.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
      console.log(`[restore] 完了: ${src} -> ${dest}`);
    } finally {
      memDb.close();
    }
  } else {
    console.error('使い方:');
    console.error('  node db/export.js export <元DBパス> <出力バックアップパス>');
    console.error('  node db/export.js restore <バックアップパス> <復元先DBパス>');
    process.exit(1);
  }
}
