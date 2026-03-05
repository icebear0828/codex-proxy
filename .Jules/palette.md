## 2025-05-14 - [Accessibility & UI Verification]
**Learning:** For apps with persistent state like account pools, manually populating the local JSON data store (`data/accounts.json`) is the most reliable way to verify UI components in isolation during development and automated verification.
**Action:** Always check `data/` or similar persistence directories to see if mock data can be injected for verification scripts.
