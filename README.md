# Ór’esař Archive

The archive runs on GitHub Pages as a static site. Publish the repository root. To preview locally, serve the root with any static file server and open its HTTP address.

- `archive.json` contains the published entries, relationships, journeys and atlas configuration. The initial snapshot uses the repository's four demo articles, one relationship and one journey.
- Put published artwork in `assets/` and reference its filename in the JSON. Entries can use `cover` and `gallery`, and the atlas uses `map.file`.
- Search, editing, relationships, the timeline, atlas layers, map artwork versions and the journey board run in the browser. Edits and uploaded artwork are stored in IndexedDB for this browser profile and site address. The first saved edit creates a local copy of the published archive. Clearing site data deletes that copy and loads the published data again.
- To migrate another archive, copy the `entries`, `relationships` and `journeys` arrays from its legacy JSON export into `archive.json`. Copy any referenced media into `assets/` and retain or update the `map` object. Anything committed here is public.
- `oresar-wiki.zip` contains the original standalone Python edition. GitHub Pages serves the static edition.
