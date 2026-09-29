(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.runningAgentOrder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function orderAgentsByActivity(agentIds, activeAgentIds) {
    const active = new Set(activeAgentIds);
    return [...agentIds].sort((left, right) => Number(active.has(right)) - Number(active.has(left)));
  }

  return { orderAgentsByActivity };
});
