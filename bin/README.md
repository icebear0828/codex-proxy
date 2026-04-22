This directory is reserved for runtime helper binaries.

Electron packaging and path resolution expect `bin/` to exist at the repo root,
even in source checkouts where the actual binaries are provided separately.
