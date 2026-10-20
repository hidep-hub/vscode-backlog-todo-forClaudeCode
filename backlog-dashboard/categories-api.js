'use strict';

// カテゴリ機能(EPIC BM-101)のHTTP API(BM-105)。tags-api.jsと同じ骨格で、server.jsが
// 肥大化しないよう別ファイルに切り出す。DB取得・body読み取り・変更通知(broadcast)は
// 依存注入で受け取る。
// カテゴリは「システムで一意」(ヒデさんの運用認識)のためワークスペースの概念を持たない
// (タグはワークスペース単位だが、カテゴリは全ワークスペース共通)。
//   GET  /api/categories                       カテゴリ一覧(使用数付き、ワークスペース横断)
//   GET  /api/categories/similar?name=         似た名前のカテゴリ一覧(作成前の確認用)
//   POST /api/create-category  {name, color?, confirmSimilar?, actor?}
//   POST /api/update-category  {categoryId, name?, color?, actor?}
//   POST /api/delete-category  {categoryId, actor?}
//   POST /api/merge-categories {sourceId, targetId, actor?}
//   POST /api/reorder-categories {orderedIds: [categoryId, ...], actor?}  並べ替え(BM-112)

const categoriesRepo = require('./db/categories-repo');
const tasksRepo = require('./db/tasks-repo');

const STATUS_BY_CODE = {
  invalid_name: 400,
  invalid_color: 400,
  invalid_request: 400,
  duplicate_category: 409,
  similar_categories: 409,
  same_category: 400,
  category_not_found: 404,
  invalid_request: 400,
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

/**
 * @param {{getDb: () => object, readRequestBody: (req) => Promise<object>, onChange: () => void}} deps
 * @returns {(req, res) => boolean} 処理した場合true(未処理ならfalseを返し呼び出し側が続行する)
 */
function createCategoriesApi({ getDb, readRequestBody, onChange }) {
  const postRoutes = {
    '/api/create-category': (db, b) => ({ ok: true, category: categoriesRepo.createCategory(db, { ...b, actor: tasksRepo.normalizeActor(b.actor) }) }),
    '/api/update-category': (db, b) => {
      requireIds(b.categoryId);
      return { ok: true, category: categoriesRepo.updateCategory(db, b.categoryId, { name: b.name, color: b.color }, tasksRepo.normalizeActor(b.actor)) };
    },
    '/api/delete-category': (db, b) => {
      requireIds(b.categoryId);
      return { ok: true, ...categoriesRepo.deleteCategory(db, b.categoryId, tasksRepo.normalizeActor(b.actor)) };
    },
    '/api/merge-categories': (db, b) => {
      requireIds(b.sourceId, b.targetId);
      return { ok: true, ...categoriesRepo.mergeCategories(db, b.sourceId, b.targetId, tasksRepo.normalizeActor(b.actor)) };
    },
    '/api/reorder-categories': (db, b) => {
      categoriesRepo.reorderCategories(db, b.orderedIds, tasksRepo.normalizeActor(b.actor));
      return { ok: true };
    },
  };

  return function handle(req, res) {
    if (req.method === 'GET' && (req.url === '/api/categories' || req.url.startsWith('/api/categories?') || req.url.startsWith('/api/categories/similar'))) {
      const url = new URL(req.url, 'http://localhost');
      try {
        if (url.pathname === '/api/categories') {
          sendJson(res, 200, { categories: categoriesRepo.listCategories(getDb()) });
          return true;
        }
        if (url.pathname === '/api/categories/similar') {
          sendJson(res, 200, { similar: categoriesRepo.findSimilarCategories(getDb(), url.searchParams.get('name') || '') });
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

module.exports = { createCategoriesApi };
