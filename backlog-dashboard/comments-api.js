'use strict';

// タスクコメント(BM-136)のHTTP API。tags-api.jsと同じく、DB取得・body読み取り・
// 変更通知(broadcast)は依存注入で受け取る。
//   GET  /api/task-comments?taskId=XX-001      コメント全件(新しい順)
//   POST /api/add-task-comment    {taskId, body, actor?}   追加(履歴には記録しない)
//   POST /api/delete-task-comment {commentId}              削除(誤入力の取り消し用)

const commentsRepo = require('./db/comments-repo');
const tasksRepo = require('./db/tasks-repo');

const STATUS_BY_CODE = {
  invalid_request: 400,
  invalid_body: 400,
  not_found: 404,
  comment_not_found: 404,
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res, e) {
  sendJson(res, STATUS_BY_CODE[e.code] || 500, { error: e.code || 'internal_error', message: e.message });
}

function invalidRequest(message) {
  const err = new Error(message);
  err.code = 'invalid_request';
  return err;
}

/**
 * @param {{getDb: () => object, readRequestBody: (req) => Promise<object>, onChange: () => void}} deps
 * @returns {(req, res) => boolean} 処理した場合true(未処理ならfalseを返し呼び出し側が続行する)
 */
function createCommentsApi({ getDb, readRequestBody, onChange }) {
  const postRoutes = {
    '/api/add-task-comment': (db, b) => {
      if (!b.taskId) throw invalidRequest('taskId is required');
      const result = commentsRepo.addComment(db, b.taskId, b.body, tasksRepo.normalizeActor(b.actor));
      return { ok: true, taskId: b.taskId, ...result };
    },
    '/api/delete-task-comment': (db, b) => {
      if (!Number.isInteger(b.commentId)) throw invalidRequest('commentId must be an integer');
      return { ok: true, ...commentsRepo.deleteComment(db, b.commentId) };
    },
  };

  return function handle(req, res) {
    if (req.method === 'GET' && (req.url === '/api/task-comments' || req.url.startsWith('/api/task-comments?'))) {
      try {
        const taskId = new URL(req.url, 'http://localhost').searchParams.get('taskId');
        if (!taskId) throw invalidRequest('taskId is required');
        sendJson(res, 200, commentsRepo.listComments(getDb(), taskId));
      } catch (e) {
        sendError(res, e);
      }
      return true;
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

module.exports = { createCommentsApi };
