'use strict';

// server.js用のDB接続シングルトン(BT-186)。
// PRAGMA foreign_keys=ONの設定とスキーマ作成はschema.createSchema()に委譲する
// (createSchemaはIF NOT EXISTS/INSERT OR IGNOREのため既存DBに対して呼んでも安全)。

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('./schema');

let dbInstance = null;

/**
 * backlogDir配下のbacklog.sqlite3への接続を返す(プロセス内シングルトン)。
 * @param {string} backlogDir - config.backlogDirを展開済みの絶対パス
 * @returns {import('node:sqlite').DatabaseSync}
 */
function getDb(backlogDir) {
  if (dbInstance) return dbInstance;
  const dbPath = path.join(backlogDir, 'backlog.sqlite3');
  dbInstance = new DatabaseSync(dbPath);
  createSchema(dbInstance);
  return dbInstance;
}

function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

module.exports = { getDb, closeDb };
