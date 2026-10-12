# AutoMix .9 — local ZIP stem installation and notices

This evaluation package adds a ZIP installer to the main AutoMix settings row. CPU/GPU choices remain visible when a pack is missing, and become selectable after a real runtime probe succeeds. The native file dialog accepts ZIP files; renderer IPC does not accept arbitrary installation paths.

Installation preflights Windows archive paths, entry types, duplicate names, file/directory collisions, file count, unpacked size and available disk space. Extraction streams bytes with CRC and SHA-256 verification. The locked checkpoint and an available package inventory are verified before launching the player-owned runtime probe. Installations are immutable and the active registry is replaced atomically. Failure/cancellation preserves existing packs; identical reinstalls compare bytes before reuse.

Python native extensions failed in an initially tested permanent directory with a 64-character content ID because the NumPy extension path exceeded Windows MAX_PATH. The final implementation uses 24-character content IDs and probes at the permanent directory before activation. The regression test verifies the probe path and ensures the registry is not published before probing.

The installation dialog offers an explicit enable/disable choice. A successful enabled install selects Auto GPU/CPU; an unchecked choice disables enhancement after success. Failure or cancellation preserves preferences. The dialog explains RAM/VRAM use, and enabled enhancement retains that notice in settings. Entering DJ mode shows a confirmation about skipped song openings/endings and overlapping mixes; cancelling retains the current mode.

Both dialogs use fixed positioning, all four insets and automatic margins. Actual Vue/Electron tests include the application's margin reset. Packaged settings tests verify dialog centers against the viewport, including installation-dialog resize and page scrolling. Settings search now includes AutoMix, stem enhancement, GPU/CPU and ZIP entries.

Validation on 2026-10-12:

- AutoMix regression suite: 50/50 passed, including 11 installer tests and actual Vue/Electron interaction checks.
- IPC contract checks: 5/5 passed; settings navigation checks: 3/3 passed.
- Node/web type checking, changed-source ESLint, production build and renderer size budgets passed. Message catalogs are emitted in a separate renderer chunk to preserve the existing size budget.
- Real packaged ZIP installation: 4,749,695,373 bytes extracted and verified; CPU and NVIDIA GeForce RTX 5070 Laptop GPU detected. GPU/CPU choices and enabled resource notice became available immediately.
- Restart of the same isolated profile: managed package and saved enhancement/device/DJ preferences restored; both dialog centers verified again.
- Player and enhancement ZIP integrity verified. Packaged native assets and player-owned workers verified; the player archive does not duplicate the optional enhancement runtime.

The .8 analysis/planner/native graphs remain unchanged. The frozen corpus results remain Natural 27/36, DJ 34/36, and DJ overlap >=16 seconds 22/36. No new PCM corpus render is claimed for this installer/UI update. AutoMix remains off in a fresh profile, and the formal release acceptance gate remains false.
