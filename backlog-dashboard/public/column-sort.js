'use strict';

// Board and EPIC detail share this presentation-only sort. The original
// position remains the tie breaker, so manual ordering is never overwritten.
(function (root) {
  const SORT_MANUAL = 'manual';
  const SORT_UPDATED_DESC = 'updated-desc';
  const SORT_DUE_ASC = 'due-asc';

  function valuesFor(item, key) {
    return [item, ...(item.children || [])].map(task => task[key]).filter(Boolean);
  }

  function latestUpdatedAt(item) {
    const values = valuesFor(item, 'updatedAt');
    return values.length ? values.reduce((latest, value) => value > latest ? value : latest) : '';
  }

  function earliestDueDate(item) {
    const values = valuesFor(item, 'dueDate');
    return values.length ? values.reduce((earliest, value) => value < earliest ? value : earliest) : '';
  }

  function sortItems(items, mode) {
    if (mode === SORT_MANUAL) return items.slice();
    return items.map((item, index) => ({ item, index })).sort((left, right) => {
      const a = mode === SORT_UPDATED_DESC ? latestUpdatedAt(left.item) : earliestDueDate(left.item);
      const b = mode === SORT_UPDATED_DESC ? latestUpdatedAt(right.item) : earliestDueDate(right.item);
      if (a && b && a !== b) return mode === SORT_UPDATED_DESC ? b.localeCompare(a) : a.localeCompare(b);
      if (a && !b) return -1;
      if (!a && b) return 1;
      return left.index - right.index;
    }).map(entry => entry.item);
  }

  root.columnSort = { SORT_MANUAL, SORT_UPDATED_DESC, SORT_DUE_ASC, latestUpdatedAt, earliestDueDate, sortItems };
})(typeof window !== 'undefined' ? window : globalThis);
