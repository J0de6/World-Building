# Ór’esař Archive

GitHub Pages serves this archive directly from the repository root. There is no application server or build step. For local development, use any static file server and open its HTTP address. For example, run `python3 -m http.server 3000` from the root.

## Published archive and browser edits

- `archive.json` supplies published entries, relationships, journeys and map configuration. Refer to published artwork by filename in `assets/`. Keep private lore, uploads and journey drafts out of the repository.
- Site edits and uploads stay in IndexedDB for the current browser profile and site address. A reload loads the current published archive and applies local edits to it. Local field edits take precedence, untouched fields receive published changes, and lists within a record, such as galleries and waypoints, are edited as a unit. A local deletion still hides its published record.
- The first visit after upgrading migrates the original browser snapshot without resetting its saved artwork. Clearing the site's data removes its local changes.
- `oresar-wiki.zip` and `server.py` are historical files excluded from the Pages site.

## Illustrated place pages

Select uploaded art as the entry cover, or set **Scene artwork** to its stored filename or a bundled scene path such as `assets/scenes/camp.webp`. **Scene focal point** takes two percentages, such as `65% 50%`, and **Scene accent** takes a six-digit hex color. Use entry IDs for **Parent region** and comma-separated **Illustrated features**. A feature's own scene or cover supplies its illustration.

## Atlas and Strategy Board

In **Live positions**, drag a token or use the arrow keys to try a location. **Add waypoint** saves its position and date, with optional notes and an archive link. The scrubber preserves the original date labels and gives separate steps to full dates within the same year. Under **Map layers and artwork**, preview an image with the existing overlays and save or restore an artwork version.
