[README.md](https://github.com/user-attachments/files/28692757/README.md)
# Arealytics — Daily Capture Submission (operator form)

Public, self-serve form for field operators to submit their daily capture
(.SRT/.TXT files + a metadata row) into Arealytics' Supabase backend.

- `index.html` — the form (wired to Supabase; contains only the public anon key, which is RLS-gated).
- `flight-decoder.js` — in-browser SRT/TXT inspection used by the form.

The internal dashboard is **not** part of this repo.
