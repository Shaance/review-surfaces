// In-memory storage layer for todos. No imports so it forms its own cluster.

export function createStore() {
  const rows = new Map();
  let nextId = 1;

  return {
    all() {
      return [...rows.values()];
    },
    insert(record) {
      const id = nextId;
      nextId += 1;
      const row = { id, ...record };
      rows.set(id, row);
      return row;
    },
    update(id, patch) {
      const existing = rows.get(id);
      if (!existing) {
        return undefined;
      }
      const updated = { ...existing, ...patch };
      rows.set(id, updated);
      return updated;
    }
  };
}
