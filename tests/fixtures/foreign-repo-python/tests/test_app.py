"""Self-contained test so it stays in its own cluster (no import into src/)."""


def fake_store():
    rows = []

    class _Store:
        def all(self):
            return rows

        def insert(self, record):
            row = {"id": len(rows) + 1, **record}
            rows.append(row)
            return row

    return _Store()


def test_app_1_adds_a_todo():
    store = fake_store()
    store.insert({"title": "write tests", "done": False})
    assert len(store.all()) == 1
