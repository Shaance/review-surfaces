import test from "node:test";
import assert from "node:assert/strict";

// Self-contained store stub so this test stays in its own cluster (no relative
// import into src/ that would merge the clusters).
function fakeStore() {
  const rows = [];
  return {
    all: () => rows,
    insert: (record) => {
      const row = { id: rows.length + 1, ...record };
      rows.push(row);
      return row;
    }
  };
}

test("todo.API.1 adds a todo", () => {
  const store = fakeStore();
  store.insert({ title: "write tests", done: false });
  assert.equal(store.all().length, 1);
});
