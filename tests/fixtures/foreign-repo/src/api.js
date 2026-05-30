// HTTP-ish API surface for the todo service. Pure functions so the fixture
// stays dependency-free and deterministic.

export function listTodos(store) {
  return store.all();
}

export function addTodo(store, title) {
  if (typeof title !== "string" || title.trim() === "") {
    throw new Error("title must be a non-empty string");
  }
  return store.insert({ title: title.trim(), done: false });
}

export function completeTodo(store, id) {
  return store.update(id, { done: true });
}
