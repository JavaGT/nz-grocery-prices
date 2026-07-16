# Dashboard (deprecated)

The dashboard server is **deprecated**. Use the new price-minder server instead:

    npm start

The new server at `src/app/server.js` serves the same archive through a SQLite
projection layer with user accounts, watch lists, preferred stores, and cross-retailer
matching. This `dashboard/` directory is preserved as a fallback only.

- The dashboard serves the JSONL archive directly (no SQLite projection).
- Run with `npm run dashboard` (port 7070) for backward compatibility.
- Tests: `test/server.test.js` (legacy dashboard tests).
- All new development should target `src/app/server.js`.