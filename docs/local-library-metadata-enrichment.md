# Local Library Metadata Enrichment

Local tracks are published through the existing SQLite library before online enrichment.
Core owns scanning and background metadata work; the renderer reads pages and sends commands.
Closing a page does not stop accepted work. Enrichment must not delay the first local-library
render, change a local track into a provider track, or write audio tags without confirmation.

There are two distinct paths:

- **Track enrichment** fills missing cover art, lyrics and compatible tag-like fields from
  enabled streaming search providers, using the existing cache policy and local-track matching.
- **Entity metadata** identifies artists, recordings, album projects and specific releases,
  then stores introductions, classification facts, credits and artwork separately from Track
  tags. These are durable Core tasks, shared only through confirmed typed identities.

The production wiring is in [Core entry](D:/Project/Twilight_Echo/src/main/coreProcess/entry.ts),
[CoreMetadataService](D:/Project/Twilight_Echo/src/core/library/metadataService.ts) and the
[SQLite worker](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseService.ts).

## Local Album Release Dates

Album cards and detail headers use local `releasedate`, `date`, then `year` tags. Invalid
calendar dates fall through to the next tag. Persisted `releaseDate` retains only the available
precision (`YYYY`, `YYYY-MM`, or `YYYY-MM-DD`); timezone suffixes never shift the calendar day.
Albums select the most frequent valid year, then the most precise date within that year.
Equal precision uses frequency, with album track order breaking ties. Collection identities
and sorting are unchanged. CUE subtracks inherit their source date; SACD ISO tracks use native years.

The date-only backfill contract is to read unchanged legacy files after the existing library
is available, merge only `releaseDate`, and retain titles, artists, artwork, lyrics, track
identities and provider matches. Successful reads set file-index `metadataVersion: 1`, including
files without a date; failed reads remain retryable. A cancelled date-only backfill must not
publish its date changes or completion markers. Date-only changes must not enqueue online
enrichment. New or actually changed files keep the normal scan and enrichment flow.

The retained JSON scan implements that narrow merge. The production SQLite scan currently
places files with `metadata_version < 1` in its ordinary parse path and merges the returned
Track fields in `commitScanBatch`; cancellation discards buffered work but retains already
committed batches. The SQLite path therefore still needs the narrow date-only behavior above
before this backfill contract can be accepted. See
[scan batch publication](D:/Project/Twilight_Echo/src/main/library/libraryDatabase.ts),
[database scanner](D:/Project/Twilight_Echo/src/main/library/libraryDatabaseScanner.ts) and
[legacy date-only merge](D:/Project/Twilight_Echo/src/main/library/libraryIndexCoordinator.ts).
Pause, cancel and progress use the existing Core scan controls, not a page-owned scan.

## Library Organization Inbox

The local-library tools menu opens **曲库整理收件箱**. Its **文件问题** section calls
`library.inbox.refresh`; Core reads revision-fenced SQLite Track pages of 200 and derives an
in-memory issue view. Opening it does not parse audio, hash files or search providers.
Missing covers include both cached cover and durable cover origin. Required-tag review covers
title/artist/album, empty or known placeholder values, and titles equal to the filename stem.
Filename matches are explicitly possible fallbacks, not proof that a file lacks a title tag.
Enrichment review means an existing medium-confidence provider match; absence of a provider match
alone is not an error. CUE entries retain distinct identities.

Users can filter, select, ignore, mark reviewed and reopen issues. Decisions belong to
[CoreInboxService](D:/Project/Twilight_Echo/src/core/library/inboxService.ts), persisted in
CoreState SQLite's `inbox` domain through `coreInboxWrite`, with the latest 20,000 decisions
retained. `library.inbox.mark` checks the view ID, decision revision and current library revision;
the renderer is only a page/selection projection. The old `twilight.library-inbox.v1`
localStorage record is a read-only, one-shot migration source, not an active writer.

Decisions remain profile-local and do not alter tracks or files. Identity plus a content
fingerprint fences old decisions; changed metadata, reimport timestamps or duplicate membership
produce pending issues again. A refreshed view replaces the issue index. Duplicate evidence must
match its library revision and requires explicit rechecking after a library change. Storage
failures are visible; Core rereads uncertain durable state rather than assuming a failed reply
means no write occurred.

Issue rows, duplicate members, tag previews and write results render in pages of 50. The dialog
retains selected issue indexes and their displayed Track projections; it does not own the full
issue index or persist decisions. The explicit **全库后台重扫与补全** command reuses
`startFullLibraryScan`, now a projection of `scan.start { mode: 'full' }`. The Settings library
panel reads Core scan/enrichment status and controls cancellation. Closing the inbox does not
cancel that shared job. Loudness jobs are not included in this inbox.

**音乐资料复核** is a separate section: `identification.inbox` returns 20 real library entities
per page, with candidate counts and source examples. Deleted, missing and pending catalog sources
are excluded. Opening, paging or rereading saved candidates is local-only; **联网重新识别** is
the explicit network action. Confirm, replace, reject, detach and historical restore use the
existing preview/revision-checked identity commands. File issue decisions are not identity
confirmations. See [M2.5](D:/Project/Twilight_Echo/docs/unified-music-library-m2.5.md).

Tag editing requires a per-file before/after preview and separate confirmation. Empty/whitespace
text fields leave existing tags intact, including fields that were typed then cleared. CUE/container
subtracks cannot be written through this file-level form; users edit the source file and rescan.
At most 1,000 distinct files can be submitted in one existing tag transaction. The form opens a
Core-owned `library.selection` snapshot and submits its ID to `library.tags.write`; the renderer
does not send trusted paths. Core checks selected row versions and incarnations, authorizes
files, reserves the scanner and drains affected file resources, then rechecks before dispatching
the journalled worker write. Accepted work outlives the dialog. Core queues affected directories
for reindexing afterward, including recovery paths; an explicit background rescan remains
available to refresh authoritative file values. Failed, rolled-back or unattempted files can be
previewed and retried separately. These fences do not lock out external editors.

The production owner is
[CoreLibraryMaintenance](D:/Project/Twilight_Echo/src/core/library/maintenanceService.ts), consumed
by [LocalLibraryTagManager](D:/Project/Twilight_Echo/src/renderer/src/components/LocalLibraryTagManager.vue).

## Core Track Enrichment Queue

- The queue uses six workers by default and clamps configuration to four through eight workers.
- Core reads at most 200 local tracks per database page. Requests are deduplicated by normalized
  title-and-artist query while queued/running; candidate search broadens only when no usable
  match has been found. Failed queries carry in-process exponential backoff (15 seconds up to
  5 minutes). This queue is not the durable entity task repository.
- Status is exposed separately from the file scan: the Settings library panel reports scanning,
  enriching, completed, failed, and cancelled states. Cancelling discards queued work and settles
  callers immediately.
- Each update carries its source Track and enriched Track. Core rereads that exact local ID,
  compares path, title, artist, album, duration, CUE range and changed fields, then commits only
  the allowed metadata patch with the database row's expected version. A removal, concurrent
  scan/edit or newer result cannot be overwritten by an old provider result. No renderer object
  reference or `saveMusicLibrary` call is a persistence authority.

## Durable Entity Identification And Enrichment

[CoreEntityMetadataService](D:/Project/Twilight_Echo/src/core/library/entityMetadataService.ts)
claims existing SQLite jobs, calls adapters outside database transactions and publishes through
`metadataFinish`. Identity confirmation and external-reference changes schedule follow-up work
through the transactional outbox; each scheduling pass handles at most 200 entities. Jobs and
demands survive Core/worker restart, with generation recovery fencing old results.

Automatic new-library and historical-backfill scopes are separately configured, both off by
default. The selected source, language, deployment permission, capability and account context
must authorize the work. Existing explicit lookup/refresh entry points do not acquire these
automatic switches as new prerequisites. A shared provider/language/typed-ID/context job retains
each consumer's demand; claim and commit check current membership, confirmed linkage and scope.
Removing one consumer does not cancel the others. Removing the last valid demand prevents a
late commit. Closing TaskCenter or a metadata panel does not cancel accepted jobs.

Introductions can come from an approved platform detail adapter, or from MusicBrainz identity
and its corroborated Wikidata/Wikipedia links. A name match or a Track `metadataMatch` is not
permission to attach that person's biography. MusicBrainz/public-service approval, Wikipedia
text permission, Commons image permission, Cover Art Archive usage and platform caching approval
are separate deployment decisions. Platform-native metadata does not require MusicBrainz public
service approval; it still requires the actual supported method and approved usage context.
The settings capability query is read-only and does not probe the network. Facts retain their
actual language, attribution, source link and permitted use/expiry; opening a page does not
automatically fetch missing material.

Stable `catalog.query` references connect local and platform song/artist/album pages to the same
entity panels. Ambiguous references require selection, not the first same-name result. Release
and album-project facts remain distinct; recording credits are not copied from an entire album.
Reference, credit, candidate and task lists are paged and revision-fenced. TaskCenter shows persistent
tasks 10 per page and demands 6 per page; cancelling withdraws only the selected demand, and
terminal requery uses explicitly selected current consumers. See
[M2.5](D:/Project/Twilight_Echo/docs/unified-music-library-m2.5.md).

Manual introductions, explicit clear/hide and restore-automatic are distinct operations.
Automatic facts never overwrite personal values; restoring automatic only removes the override
and rereads saved facts. Personal pictures and per-entity introduction-source preferences live
in SQLite, independent of playback source preferences. A preference selects existing permitted
text, not a new network source. Personal music backup preserves these values and known-provenance
imported text; automatic/restricted caches and jobs are excluded. Unknown old Rhine prose needs
per-version rights review before export. See
[M5.2](D:/Project/Twilight_Echo/docs/unified-music-library-m5.2.md).

## Cancellation Fences Remain Necessary Across Processes

`LibraryMetadataEnrichmentQueue` supplies an `AbortSignal` to provider adapters and aborts every
active controller on cancellation. This is used when an adapter supports request aborting.

Production Core forwards the signal to `plugins.callProvider`; the plugin manager propagates
cancellation to queued/active host RPC. An adapter may still finish work that it cannot physically
abort. Queue generation checks, source comparisons and database CAS therefore remain required
even with transport cancellation. Entity tasks additionally check durable generation, current
consumers and usage context at publication. Shutdown joins accepted writes; a client disconnect
does not reinterpret an accepted durable job as cancelled.
