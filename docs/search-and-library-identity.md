# Search And Library Identity

## Search Requests

The independent Search page uses the existing streaming search controller for songs, albums,
playlists and artists. Its source choices are All, Local, and enabled providers that implement the selected
search method. All-source songs retain logical-track grouping; collections retain provider IDs.
Partial collection failures keep successful sources visible and name the failed providers. Each
collection page shares one global offset, with local results followed by providers in registry
order; only the requested window is rendered, without fetching full result sets. Each
streaming destination retains its own source, filters, detail stack and scroll position for the
app session. Local list queries and existing view preferences are scoped by page/detail identity.

Search orchestration and matching belong to
[CoreMusicSearchService](D:/Project/Twilight_Echo/src/core/search/service.ts).
The renderer sends `search.songs` / `search.collections` queries and receives public pages;
it does not rebuild the production library or own provider calls. Local songs use SQLite
`queryTracks`; local artists/albums use `queryCollections`, while application playlists use the
Core playlist repository. Unified song search also includes matching entries from the configured
network-source catalog. Network profiles and search cache entries do not become music-library
members merely because they appear in a search result.

The title bar and Ctrl+K remain available. Page actions in the command palette come from the same
registry as the sidebar, including pages hidden by the user's sidebar preferences. Opening a
hidden destination does not change those preferences.

The sidebar groups provider destinations under Streaming Music and local songs, albums, artists,
application playlists, folders and genres under Music Library. Provider collections are labelled
My Music Library within the streaming branch; application favourites remain in Playlists.
Expanding or collapsing a branch does not change the active destination, search state or playback.

Renderer search state is committed only by the latest monotonically increasing request id.
Each Streaming search snapshots `query`, `type`, `source`, and `offset` before calling a
provider. Unified search snapshots its query and pagination inputs. A later response from an
older snapshot must not change results, loading state, or error state.

`pagehide` and component disposal invalidate outstanding request ids. They do not make a
network request successful or turn an old response into current UI state.

The title-bar command button and Ctrl+K / Command+K open the command palette. An empty query
shows common actions without searching or changing audio settings. Prefix a query with `>` to
search only actions and the existing settings index. Other queries search unified songs and
application playlists after a 250 ms debounce. Song selection uses the normal player
route; playlist selection opens its existing detail view. Device profiles open the playback
settings anchor; opening EQ, DSP or a settings result does not apply a configuration.

The palette renders a bounded virtual window and pages songs and playlists in batches of 20
per source. Unified search caps each source page at 100 and reports `hasMore` from individual
source totals, rather than treating their combined total as one source's page count.
Production local song queries use SQLite's normalized text/filename indexes and source-priority
ordering, including the current manual preferred sources. The retained JSON-library adapter
uses an immutable-array search index for its existing callers; it is not a second renderer
authority. Logical grouping uses Core's `logicalTrackModel` within the returned source pages.
Displayed source variants are those found in the current page, not an exhaustive list of every
source for the recording.

Core checks the library, manual-version and, where applicable, network revisions before
returning results; collection search also checks its library/playlist revision. Public pages
carry the relevant revisions and projected tracks, not private paths, credentials or playback
URLs. A newer renderer request ID cannot make an old Core revision current. The local-search
bridge is [useLibraryUnifiedSearch](D:/Project/Twilight_Echo/src/renderer/src/app/useLibraryUnifiedSearch.ts);
the unified bridge is [useUnifiedMusicSearch](D:/Project/Twilight_Echo/src/renderer/src/app/useUnifiedMusicSearch.ts).

Typing clears old selectable results immediately; newer queries and closing abort provider
requests and invalidate late network-library reads. IME composition does not search, execute,
or dismiss the palette until the composition commits. Arrow keys, Enter and Escape work with
the native modal dialog's focus containment; closing restores the prior control. Disabled
actions explain the unavailable state. Ctrl+K / Command+K are reserved application shortcuts:
existing conflicting global bindings remain saved but are not registered, and settings reports
the conflict instead of dispatching two actions.

## Album Identity

Album search reuses the local library's derived album groups, matching album names and album
artists, including pinyin initials and multiple whitespace-separated terms. Online providers
opt in with the optional `searchAlbums` method; NetEase uses `/cloudsearch` with `type=10`.
Results retain the provider ID and release ID, display artist and source labels, and share the
collection paginator. Equal names or IDs from different sources are never merged automatically.
Album detail loads use the result's source rather than the currently selected streaming provider;
local details retain the library's disc/track order. Opening a result keeps the search query,
source and page intact for back navigation. NetEase album search and detail reads support
anonymous requests and attach the existing cookie when signed in.

The album display name is not an identity. Local-library album groups use `albumId` when
available. Otherwise they use the normalized `albumArtist + album` tuple, with `artist` as the
legacy fallback for files that do not carry an album-artist tag. Album navigation and Vue keys
use this group id, so two artists with the same album title remain separate.

These local collection IDs and provider-native search IDs are source/navigation identities.
The metadata catalog separately stores physical recordings and releases, album projects and
artists, with typed external references and revisioned confirmed links. Equal names, an ISRC,
a high search score or an old Track `metadataMatch` alone do not establish a persisted shared
identity. Local and streaming sources can share metadata after the relevant identity is
confirmed; each source keeps its own membership, availability and playback identity.

Existing song/artist/album pages read `LibraryPage.catalog` references or an explicit
`catalog.query` context. They do not choose a biography by the first matching artist name.
Ambiguous references require the user to choose the object to read; this choice itself does
not confirm an external identity. Introduction overrides, explicit clears, images, credits and
fact attribution use the shared entity panels. See
[metadata reading and review](D:/Project/Twilight_Echo/docs/unified-music-library-m2.5.md).

Album browsing preserves the hierarchy **album project → specific release or unidentified
local album → actual library sources**. Physical release IDs and confirmed metadata links own
that hierarchy. Two pressings remain different releases even if a user places their sources
in one manual playback version. Browsing reads current library releases, does not enumerate
unavailable external discographies, add members or start network enrichment. See
[release/source browsing](D:/Project/Twilight_Echo/docs/unified-music-library-m3.3.md).

## Manual Recording And Release Versions

The library tools menu, track information dialog and album detail toolbar expose song and
album playback-version management. A version contains explicitly associated interchangeable
playback sources; a version family links distinct versions without merging metadata identities.
Labels, source grouping, explicit splits, families and separate preferred-version/preferred-source
choices belong to [CoreRecordingVersions](D:/Project/Twilight_Echo/src/core/playlists/recordingVersions.ts).
The authority is CoreState SQLite's `core_state(domain='versions')`, with a domain revision.
`twilight.music-versions.v1` localStorage is retained only as a read-only one-shot migration
source. Existing libraries keep their Track IDs and do not need a file rewrite.
Remote source keys use provider and item ID; local keys use normalized path, subtrack and CUE range,
so rescanning with new generated track IDs retains overrides. Moving a file changes its key.

Manual relationships take priority in the shared logical track model, legacy favorite matching,
playlist resolution, unified search/recent items and applicable playback fallback. Unannotated
tracks retain legacy candidate matching; that does not create a persisted metadata recording
relationship. Different IDs from one provider and conflicting live/remaster/acoustic markers
remain separate. A local candidate cannot bridge two otherwise incompatible provider recordings.

The metadata identity graph and manual playback graph serve different contracts. Metadata
confirmation does not silently make two sources interchangeable for playback. A manual version
does not merge physical recordings/releases, metadata links, ratings or personal preferences.
The library catalog projects the authoritative version graph for navigation; it does not become
a second version writer.

Edits show a preview before saving; withdrawing a relationship restores automatic interpretation.
The renderer's [version store](D:/Project/Twilight_Echo/src/renderer/src/stores/library/coreMusicVersions.ts)
holds a frozen display projection and uncommitted previews. It loads `versions.page` in batches
of 128, tied to the Core epoch and version revision, and sends `versions.edit` with the preview's
expected revision. Core serializes edits and atomically replaces/validates the complete graph
through the database worker. Conflicts or invalid data leave the existing graph intact; an
uncertain write outcome is resolved by rereading, not replaying the edit.

`versions.catalog` supplies paged source choices from the library and saved playlist snapshots.
Missing sources remain visible for repair; catalog presence is not proof of current playback
availability. The management lists and member details render 50 entries per page. Album sources
reuse existing album identities and retain disc and track order.

Playing a preferred version is explicit. The version manager's **play preferred** action resolves
the chosen version/source and reports an absent preferred source for repair; it does not silently
choose a different source. **Play this source** (`catalog.play`) keeps the exact selected source.
Ordinary explicit playback does not switch recordings merely because they share a family.

**Unified play this track** (`catalog.playUnified`) is a separate opt-in action. It reads the
manual track-version graph and any explicit family preferred version, then ranks sources within
that selected version by manual preferred source, the page's provider order, first actual library
membership publication and stable source ID. With no manual track equivalence it tries only the
anchor. Album relationships alone do not supply per-track equivalence. A frozen local/spec/release
filter remains a hard scope; source preference cannot escape it.
Unknown membership dates remain unknown and sort after known dates, rather than using upgrade time.

Unified playback prepares each eligible source at most once through normal provider resolution,
file authorization, URL expiry and source leases. Preparation failure may try the next source
in the same selected version; permission denial, cancellation or stale scope stops preparation.
Only a fully prepared result replaces the queue once. Native submission failure does not retry
another source, and playback never switches sources mid-track. The old queue stays active if
preparation fails. See [M3.3](D:/Project/Twilight_Echo/docs/unified-music-library-m3.3.md).
Version management never writes tags or merges files.

## Library Membership And Personal Classification

Search results and cached provider details are not library membership. Catalog reads can select
the real-library scope or cached catalog scope; the latter does not search the wider network.
Confirmed metadata identity is used for same-type entity grouping in Focus, while unconfirmed
items keep their physical identities. Manual playback versions do not redefine those groups.

Personal recording and specific-release half-star ratings are separate from `none`, `favorite`
and `ban` preferences and from provider facts. There is currently no approved external rating provider:
base ratings are missing, and effective ratings use applicable personal values. Audio quality,
popularity and match confidence are not converted into stars. Artist automatic bans use confirmed
main-artist relationships, not every person listed in credits. Explicit playback remains explicit;
the automatic recommendation boundary applies bans without stopping the current track or
reordering an existing queue. See
[preferences and automatic bans](D:/Project/Twilight_Echo/docs/unified-music-library-m4.2.md).

The default favorites view and ordinary playlists now read the existing SQLite playlist authority;
the old JSON is recovery material, not a parallel writer. Ordinary playlists and preserved default
favorite occurrences retain order and duplicates. Explicit `none`/`ban` controls the visible
favorite projection; it does not rewrite an ordinary playlist. Offline personal anchors retain
their values and exact source references but do not authorize playback from imported snapshots
or a coincidentally equal Track ID. Exact source return can reconnect them. The `versions` backup
domain remains the owner of playback-version relationships, while the `music` domain carries
ratings, preferences, tags, saved Focus queries and other personal metadata. See
[personal music backup](D:/Project/Twilight_Echo/docs/unified-music-library-m5.2.md).

Focus combines genres/hierarchy, sources/specifications, ratings, tags, years, preferences, history
and classification dimensions as a parameterized SQLite query. Results, facets and saved queries
render 20 per page, with public query limits of 200. Counts and playback use the same frozen query
and full revision token; changed dependencies require an explicit refresh. Collection playback
streams batches of at most 100 into the existing hidden queue builder rather than loading all
Tracks or prefetching all streaming URLs. Page bounds cap payload size; SQLite can still evaluate
the complete scope to compute counts and facets. See
[Focus query and playback](D:/Project/Twilight_Echo/docs/unified-music-library-m4.4.md).

## Folder Identity

Folder cards represent configured scan roots. A root owns tracks whose normalized file paths are
equal to the root or start with the root followed by a path separator. This includes nested
directories while excluding similarly prefixed siblings such as `C:\\music-other` for the root
`C:\\music`.
