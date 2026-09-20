# PikPak Multi-Download

A userscript that adds **batch downloading** to the [PikPak](https://mypikpak.com) web app - pick multiple files and get them in **one streamed ZIP**, with IDM-style parallel chunks for speed. Works on your own Drive folders **and on public Share links without importing them first**, bypassing the "Open the PikPak desktop app to download multiple files" prompt.

<!-- Install badge/link filled in after GreasyFork publish -->
[![Install on Greasy Fork](https://img.shields.io/badge/Install-Greasy%20Fork-670000?logo=greasyfork&logoColor=white)](https://greasyfork.org/scripts/GREASYFORK_ID)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Batch download** - select many files, download them all as a single `.zip`.
- **No more per-file popups** - the ZIP is streamed straight to disk via the File System Access API (low RAM, handles many GB), so the browser asks for a save location **once**.
- **Fast (IDM-style)** - each file is fetched with several parallel byte-range connections (~3.5x faster than a single connection in testing).
- **Share links, no import** - on a `/s/...` share page, links are collected as you preview files, then batch-downloaded. No need to "Save to my PikPak" first.
- **Thumbnails + List/Grid view** - real file thumbnails, switchable layout.
- **Per-file progress bars**, overall progress in the tab **title** and a **spinning favicon**, plus a completion **notification**.
- **Safety** - blocks accidental modal close / page reload while a download is running.
- **Retry** - a retry button on each failed file, plus a "Retry failed" button for all of them.

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) (recommended) or [Violentmonkey](https://violentmonkey.github.io/).
2. Install the script from **[Greasy Fork](https://greasyfork.org/scripts/GREASYFORK_ID)** (auto-updates), or from the [raw file](https://raw.githubusercontent.com/DungGramer/pikpak-multi-download/main/pikpak-multi-download.user.js).

## Usage

### Drive (your own files)
1. Open a folder on `https://mypikpak.com/drive/...`.
2. Click the floating **⬇ Download** button (bottom-right).
3. Tick the files you want, then **Download ZIP**.

### Share links (no import needed)
1. Open a share page `https://mypikpak.com/s/...`.
2. **Preview** each file you want - its download link is collected automatically (use the thumbnail strip inside the preview to flip through quickly).
   > A userscript cannot open the preview for you: the site requires a real click to sign each file's request, so previewing is the manual step.
3. Click **⬇ Download share**, tick the collected files, then **Download ZIP**.

## How it works

- Reads your session (access token + captcha token + device id) from `localStorage` and calls PikPak's own API.
- Drive: lists the folder via `GET /drive/v1/files`, resolves each file's signed `web_content_link` via `?usage=FETCH`.
- Share: hooks `share/file_info` responses to harvest each file's **origin** media link as you preview.
- Downloads each file with parallel HTTP `Range` requests and bundles them with [fflate](https://github.com/101arrowz/fflate) (`store`, no re-compression) straight to disk.

Everything runs locally in your browser against PikPak's endpoints - the script sends nothing to any third party.

## Limitations

- **Share downloads are capped by PikPak at ~1.8 GB per file** when downloading *without* importing (measured). Files larger than that stop mid-way - use **"Save to my PikPak"** and then download them from your Drive (no cap there). This is a server-side limit, not a script bug.
- Requires a Chromium-based browser for the streamed-ZIP path (File System Access API). Other browsers fall back to per-file downloads.
- MP4/video files do not compress, so the ZIP only bundles them (no size reduction) - the benefit is one file and no popups.

## Disclaimer

This tool only downloads files you already have access to (your own Drive or a share link someone gave you), using PikPak's own web API. Use it in accordance with PikPak's Terms of Service. Provided as-is under the MIT License.

## License

[MIT](LICENSE) © DungGramer
