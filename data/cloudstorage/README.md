# Hotfix files (cloud storage)

Files in this folder are served to every build from `/fortnite/api/cloudstorage/system`
(for example `DefaultEngine.ini`, `DefaultGame.ini`, `DefaultRuntimeOptions.ini`).

Put season-specific files in `season<N>/` (e.g. `season4/DefaultGame.ini`); a file there
replaces the same-named file from this folder for builds of that season.

`.md` and `.txt` files are never served. Changes apply immediately, no restart needed.
