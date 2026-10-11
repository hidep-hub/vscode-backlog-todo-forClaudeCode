'use strict';

// タグ機能(EPIC BT-391)のHTTP API(BT-393)。server.jsが肥大化しないよう別ファイルに切り出し、
// DB取得・body読み取り・変更通知(broadcast)は依存注入で受け取る。
//   GET  /api/tags?workspace=<file>               タグ一覧(使用数付き)
//   GET  /api/tags/similar?workspace=<file>&name= 似た名前のタグ一覧(作成前の確認用)
//   POST /api/create-tag      {workspace, name, color?, confirmSimilar?, actor?}
//   POST /api/update-tag      {tagId, name?, color?, actor?}
//   POST /api/delete-tag      {tagId, actor?}
//   POST /api/merge-tags      {sourceId, targetId, actor?}
//   POST /api/update-task-tags {taskId, add?: [tagId], remove?: [tagId], actor?}

const tagsRepo = require('./db/tags-repo');
const tasksRepo = require('./db/tasks-repo');

const STATUS_BY_CODE = {
  invalid_name: 400,
  invalid_color: 400,
  invalid_workspace: 400,
  unknown_workspace: 400,
  invalid_request: 400,
  duplicate_tag: 409,
  similar_tags: 409,
  same_tag: 400,
  workspace_mismatch: 400,
  tag_not_found: 404,
  not_found: 404,
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res, e) {
  const status = STATUS_BY_CODE[e.code] || 500;
  const body = { error: e.code || 'internal_error', message: e.message };
  if (e.existing) body.existing = e.existing;
  if (e.similar) body.similar = e.similar;
  sendJson(res, status, body);
}

function requireIds(...values) {
  for (const v of values) {
    if (!Number.isInteger(v)) {
      const err = new Error('IDは整数で指定してください');
      err.code = 'invalid_request';
      throw err;
    }
  }
}

function requireIdArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(Number.isInteger)) {
    const err = new Error(`${field}はタグIDの整数配列で指定してください`);
    err.code = 'invalid_request';
    throw err;
  }
  return value;
}

/**
 * @param {{getDb: () => object, readRequestBody: (req) => Promise<object>, onChange: () => void}} deps
 * @returns {(req, res) => boolean} 処理した場合true(未処理ならfalseを返し呼び出し側が続行する)
 */
function createTagsApi({ getDb, readRequestBody, onChange }) {
  const postRoutes = {
    '/api/create-tag': (db, b) => ({ ok: true, tag: tagsRepo.createTag(db, { ...b, actor: tasksRepo.normalizeActor(b.actor) }) }),
    '/api/update-tag': (db, b) => {
      requireIds(b.tagId);
      return { ok: true, tag: tagsRepo.updateTag(db, b.tagId, { name: b.name, color: b.color }, tasksRepo.normalizeActor(b.actor)) };
    },
    '/api/delete-tag': (db, b) => {
      requireIds(b.tagId);
      return { ok: true, ...tagsRepo.deleteTag(db, b.tagId, tasksRepo.normalizeActor(b.actor)) };
    },
    '/api/merge-tags': (db, b) => {
      requireIds(b.sourceId, b.targetId);
      return { ok: true, ...tagsRepo.mergeTags(db, b.sourceId, b.targetId, tasksRepo.normalizeActor(b.actor)) };
    },
    '/api/update-task-tags': (db, b) => {
      if (!b.taskId) {
        const err = new Error('taskId is required');
        err.code = 'invalid_request';
        throw err;
      }
      const tags = tagsRepo.updateTaskTags(db, b.taskId,
        { add: requireIdArray(b.add, 'add'), remove: requireIdArray(b.remove, 'remove') },
        tasksRepo.normalizeActor(b.actor));
      return { ok: true, taskId: b.taskId, tags };
    },
  };

  return function handle(req, res) {
    if (req.method === 'GET' && (req.url === '/api/tags' || req.url.startsWith('/api/tags?') || req.url.startsWith('/api/tags/similar'))) {
      const url = new URL(req.url, 'http://localhost');
      const workspace = url.searchParams.get('workspace') || null;
      try {
        if (url.pathname === '/api/tags') {
          sendJson(res, 200, { tags: tagsRepo.listTags(getDb(), workspace) });
          return true;
        }
        if (url.pathname === '/api/tags/similar') {
          if (!workspace) {
            sendJson(res, 400, { error: 'invalid_workspace', message: 'workspaceは必須です' });
            return true;
          }
          sendJson(res, 200, { similar: tagsRepo.findSimilarTags(getDb(), workspace, url.searchParams.get('name') || '') });
          return true;
        }
      } catch (e) {
        sendError(res, e);
        return true;
      }
      return false;
    }

    const route = req.method === 'POST' ? postRoutes[req.url] : null;
    if (!route) return false;
    readRequestBody(req).then(body => {
      try {
        const result = route(getDb(), body || {});
        sendJson(res, 200, result);
        onChange();
      } catch (e) {
        sendError(res, e);
      }
    }).catch(() => {
      sendJson(res, 400, { error: 'Invalid JSON body' });
    });
    return true;
  };
}

module.exports = { createTagsApi };
