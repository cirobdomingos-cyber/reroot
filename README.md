# auê social assets

Published Instagram images, hosted here so the Instagram API can fetch them by URL. Not app code; never merged.

## Queue (posted by the Railway cron `social-poster`)

`queue.json` lists the carousels the cron publishes (`scripts/social/post-next.mjs` on main, daily 21:00 UTC = 18h BRT, at most one post per run). An item is `{"folder", "slides": [...], "tags": {"<slide>": "<handle>"}, "not_before", "not_after"}`; the folder holds the JPEG slides and `caption.txt`. A post counts as published when a caption on the profile starts with the item's first caption line, so a push here is all it takes to schedule one. One scheduler per date: never also post the same item from a chat.
