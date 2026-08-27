---
'cf-knex': patch
---

mysql2 adapter: synthesize a message for driver errors that arrive with an empty one. A server/proxy error packet is allowed to carry no text (observed from Hyperdrive in production), and mysql2/promise's pre-captured rejection Error then keeps `message: ''` — anything that serializes the error as its stack logs a headerless `Error\n    at …` while the identifying `code`/`errno`/`sqlState` stay attached but invisible. `execute()` and `acquire()` now name such failures from those driver fields on the same error object (identity and fields untouched; the synthesized message reaches the stack header too, since V8 formats `.stack` on first access). Errors that already have a message, and empty-message errors with no driver fields, pass through untouched.
