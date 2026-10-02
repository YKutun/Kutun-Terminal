# Retained evidence

Historical timestamped source-backup folders were removed from the active tree after Stage 2D3.
They live in the recovery ZIP and in Git commit `7f9b987` (documentation only; datasets that were never committed remain in the ZIP).

## commodities_data_pre_refresh_20260916.json

| | |
|---|---|
| SHA-256 | `D1BEDA347ECA8F0D6292DA61E951CE6957892EA61A53574B60D89ACF89B662EB` |
| Source | Byte-for-byte copy of `_pre_refresh_20260916_214324/commodities_data.json` (identical to `_pre_refresh_20260916_214406/commodities_data.json`) |
| Why kept | Unresolved Lumber history (backup: 4,597 records, 2005-01-03 to 2023-05-15; production: one 2023-04-10 record at 380.6 vs backup 382.7 that day) and Gold price revisions (1,389 shared dates 2020-05-29 to 2026-03-13; cause unknown) |

Compare against a staged commodity candidate:

```
py stage2c_review.py compare --staging staging_stage2c1_YYYYMMDD_HHMMSS --baseline evidence/commodities_data_pre_refresh_20260916.json
```

`--baseline` can be omitted; the path above is the default. Any other historical `commodities_data.json` can be passed instead.

## `_pre_repair_checksums.json` / `_pre_stage1a_checksums.json`

Stage 1A checksum snapshots, kept as small provenance notes. Not used by tests.
