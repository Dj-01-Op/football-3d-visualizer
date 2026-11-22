# Football Spatial Replay

An offline-first browser visualization of 3D football tracking data. It renders 3,000 frames of tracked player skeletons and ball movement as a daylight stadium replay with cartoon player bodies, embedded player portraits, multiple cameras, motion trails, and an instanced audience.

The deployed site is a single static file. It needs no API, database, paid server, or runtime dependencies.

## View it locally

The ready-to-use site is `public/index.html`.

### Windows

Open a terminal in this folder and run:

```text
py -m http.server 8000 --directory public
```

### macOS or Linux

```text
python3 -m http.server 8000 --directory public
```

Then visit `http://127.0.0.1:8000`.

You can also double-click `public/index.html` in a current browser. A local server gives more consistent browser behavior.

## Deploy free with GitLab Pages

This repository includes `.gitlab-ci.yml`. GitLab Pages publishes the committed `public/index.html` as a static site.

1. Create a blank GitLab project.
2. Extract this ZIP and open the folder in VS Code.
3. Open the VS Code terminal and run:

```text
git init
git add .
git commit -m "Add football 3D visualizer"
git branch -M main
git remote add origin YOUR_GITLAB_REPOSITORY_URL
git push -u origin main
```

4. In GitLab, watch **Build > Pipelines**.
5. After the pipeline succeeds, open **Deploy > Pages** for the public URL.

GitLab Pages hosts plain HTML, CSS, and JavaScript without a separate server. GitLab.com offers Pages at no additional hosting charge, subject to the account's current CI/CD quotas and terms.

## Customize the visualizer

- `viewer/app.js`: stadium, grass, crowd, characters, cameras, lighting, and interface wiring.
- `viewer/core.js`: playback, decoding, tracking logic, layers, and data rules.
- `viewer/template.html`: HTML layout and CSS.
- `viewer/roster.json`: player-name, jersey, portrait, and attribution mapping.
- `viewer/portraits/`: local portrait files embedded during a rebuild.
- `build/codec.py`: compact tracking-data encoder.
- `build/build.py`: secure single-file builder.

The current identity overlay treats `Home` as FC Bayern because the source dataset contains only `Home`, `Away`, and jersey numbers. This is labeled as an assumption in the interface. Uncertain jersey mappings remain generic.

## Rebuild with tracking data

The ready site in `public/` does not need a rebuild. To regenerate it from the source data:

1. Put your private HTML redirect stub at `data.parquest` in the project root. It is ignored by Git.
2. Create the environment and install binary wheels:

```text
python3 -m venv .venv
.venv/bin/pip install --only-binary=:all: -r build/requirements.txt
```

3. Build:

```text
.venv/bin/python build/build.py --stub data.parquest --out public/index.html
```

On Windows, use `.venv\Scripts\python.exe` instead of `.venv/bin/python`.

The builder downloads the Parquet file to a temporary directory, verifies it, embeds the compressed tracking payload and all local assets, then deletes temporary data. It never prints or writes the signed URL into the output.

## Security

Never commit `data.parquest`. It contains a temporary signed download URL. The supplied ZIP excludes that file, the Parquet data, virtual environments, caches, and Git history.

## Browser support

Use a current desktop version of Chrome, Edge, Firefox, or Safari with WebGL and `DecompressionStream` support. Disable the **Audience** layer on slower devices.

## Credits

See `ATTRIBUTIONS.md`. Portrait licenses and source links are also shown inside the visualizer.
