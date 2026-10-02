# MiSans UI smoothing metadata

The packaged MiSans 4.003 subsets were updated on 2026-10-03 to enable
`GASP_SYMMETRIC_SMOOTHING` (`0x0008`) in every existing `gasp` range.
Previously, the 9–16 PPEM range used `0x0007`, which made small UI text render
with hard horizontal edges through Windows DirectWrite. It now uses `0x000F`.

Only smoothing metadata was edited before regenerating the font containers.
Glyph outlines, metrics, Unicode coverage, family names, and weight mapping are unchanged.
The original Apache 2.0 license is retained in `LICENSE`.

The font packaging test reads the WOFF2 metadata and checks smoothing at common
UI sizes. No system font installation or font processing dependency is required
to build or run the application.

References:
- [OpenType gasp specification](https://learn.microsoft.com/en-us/typography/opentype/spec/gasp)
- [Official MiSans downloads](https://hyperos.mi.com/font/zh/download/)
