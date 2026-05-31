"""Pure-function todo API for the foreign python fixture. No imports so it stays
deterministic and forms its own cluster."""


def list_todos(store):
    return store.all()


def add_todo(store, title):
    if not isinstance(title, str) or title.strip() == "":
        raise ValueError("title must be a non-empty string")
    return store.insert({"title": title.strip(), "done": False})


def complete_todo(store, todo_id):
    return store.update(todo_id, {"done": True})
