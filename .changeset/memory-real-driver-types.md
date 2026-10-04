---
'@cogitator-ai/memory': patch
---

The SQLite (`SQLiteAdapter`, `SQLiteGraphAdapter`, `CoreFactsStore`) and MongoDB adapters are now type checked against the real `better-sqlite3` and `mongodb` drivers instead of hand-written declarations of them. Those declarations took precedence over the drivers' own types, which is how a Qdrant client method that no longer existed went unnoticed. A driver release that drops or changes a method the adapters call now fails the build instead of failing at runtime. Checking the adapters against `better-sqlite3` 13 and `mongodb` 7 found no mismatch, so behaviour is unchanged.
