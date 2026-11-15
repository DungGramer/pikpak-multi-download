// ==UserScript==
// @name         PikPak Multi-Download
// @namespace    dunggramer.pikpak
// @version      2.9.0
// @description  Download many PikPak files at once (Drive folders + Share links, no import needed): thumbnails, per-file progress, one streamed ZIP written straight to disk, IDM-style parallel chunks (~3.5x), close/reload guard, spinning favicon + notification, per-file retry. Share mode harvests links as you preview, then batch-downloads. Bypasses the "Open the PikPak desktop app" prompt.
// @author       DungGramer
// @license      MIT
// @match        https://mypikpak.com/*
// @require      https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
// @icon         https://mypikpak.com/favicon.ico
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * How it works (reverse-engineered 2026-09-19):
 *  - Auth: localStorage credentials_<id>.access_token + captcha_<id>.captcha_token + deviceid.
 *  - List: GET /drive/v1/files?parent_id=<folder>&thumbnail_size=SIZE_MEDIUM (paginated via
 *    next_page_token). thumbnail_link is only returned when thumbnail_size is passed.
 *  - Download link: GET /drive/v1/files/<id>?usage=FETCH -> web_content_link. The localStorage
 *    captcha token is enough (generic action); it lasts ~5 min and the app refreshes it on load.
 *  - ZIP: fflate.Zip (ZipPassThrough = store; mp4 does not compress, so this just bundles),
 *    streamed into a file chosen via showSaveFilePicker (File System Access API) -> written
 *    straight to disk, low RAM, one file, no per-file save popups. The CDN allows CORS range
 *    reads (measured: 206 + readable body).
 * The app's grid is virtualized (off-screen files are not in the DOM), so the panel lists
 * files through the API instead of scraping the grid.
 */
(function () {
  'use strict';

  const API = 'https://api-drive.mypikpak.com/drive/v1/files';
  const LINK_CONCURRENCY = 4;  // resolve links in parallel (within the ~5 min token window)
  const CHUNK_SIZE = 8 * 1024 * 1024;  // 8MB per range - IDM-style chunking
  const CHUNK_CONCURRENCY = 5; // parallel ranges per file (measured: 1 conn ~1.9MB/s, 4-5 conn ~6.6MB/s = 3.5x; >6 tends to drop)
  const SMALL_FILE = 2 * CHUNK_SIZE; // below this a file is one request; several are fetched in parallel ahead of the zip writer
  const FILE_PREFETCH = 4;           // files fetched ahead (RAM <= ~(FILE_PREFETCH+1) x SMALL_FILE). Measured on 12 small files: 4 parallel ~0.8s vs 2.1-3.2s sequential
  const PROBE_MAX = 24;        // max 1-byte probes per big file before adding it to the zip (finds unreadable regions)
  const PROBE_MIN_GAP = 2 * 1024 * 1024; // probes are at least this far apart (small files are probed densely)
  const CHUNK_RETRIES = 3;     // retry a range on transient errors (many connections drop occasionally)

  // ── auth ─────────────────────────────────────────────────────────────────
  function freshCaptcha() {
    const k = Object.keys(localStorage).find(x => x.startsWith('captcha_'));
    if (!k) return '';
    try { return (JSON.parse(localStorage.getItem(k)) || {}).captcha_token || ''; } catch (e) { return ''; }
  }
  function getAuth() {
    const k = Object.keys(localStorage).find(x => x.startsWith('credentials_'));
    if (!k) throw new Error('Not signed in to PikPak.');
    const c = JSON.parse(localStorage.getItem(k));
    if (!c.access_token) throw new Error('Could not read access_token.');
    return { token: c.access_token, deviceId: localStorage.getItem('deviceid') || '' };
  }
  function headers(a) {
    const h = { 'Authorization': 'Bearer ' + a.token };
    const ct = freshCaptcha();
    if (ct) h['x-captcha-token'] = ct;
    if (a.deviceId) h['x-device-id'] = a.deviceId;
    return h;
  }
  function currentFolderId() {
    const s = location.pathname.split('/').filter(Boolean).pop() || '';
    return /^[A-Za-z0-9_-]{16,}$/.test(s) ? s : '';
  }

  // ── API ────────────────────────────────────────────────────────────────────
  async function listAll(parentId, a) {
    const files = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({ parent_id: parentId, limit: '100', thumbnail_size: 'SIZE_MEDIUM', filters: '{"trashed":{"eq":false}}' });
      if (pageToken) q.set('page_token', pageToken);
      const r = await fetch(API + '?' + q.toString(), { headers: headers(a) });
      const j = await r.json();
      if (!r.ok) throw new Error('List failed ' + r.status + ' ' + (j.error_description || ''));
      for (const f of (j.files || [])) if (f.kind === 'drive#file') files.push(f);
      pageToken = j.next_page_token || '';
    } while (pageToken);
    return files;
  }
  async function getLink(id, a) {
    const r = await fetch(API + '/' + id + '?usage=FETCH', { headers: headers(a) });
    const j = await r.json();
    if (!r.ok || !j.web_content_link) {
      const code = j.error_code;
      if (code === 9 || code === 16) throw new Error('CAPTCHA_EXPIRED');
      throw new Error('Link failed ' + r.status + ' ' + (j.error_description || code || ''));
    }
    return j.web_content_link;
  }

  // ── unique names inside the zip (avoid collisions) ──────────────────────────
  function uniquify(names) {
    const seen = {};
    return names.map(n => {
      if (!seen[n]) { seen[n] = 1; return n; }
      const dot = n.lastIndexOf('.'); const base = dot > 0 ? n.slice(0, dot) : n; const ext = dot > 0 ? n.slice(dot) : '';
      return base + ' (' + (seen[n]++) + ')' + ext;
    });
  }

  const fmtSize = (n) => { n = +n || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; };

  async function ensureFflate() {
    if (window.fflate) return window.fflate;
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load the zip library.')); document.head.appendChild(s); });
    return window.fflate;
  }

  // Resolve every file's link FIRST (fast, within the ~5 min token window) with limited
  // concurrency. The ZIP stream afterwards can run for a long time (many GB) without needing
  // the token again because web_content_link is already signed (long-lived). Throws
  // CAPTCHA_EXPIRED if the token expired.
  async function resolveLinks(items, auth, onEach, setRowStatus) {
    let expired = false, i = 0;
    async function worker() {
      while (i < items.length && !expired) {
        const it = items[i++];
        setRowStatus(it.idx, '...');
        try { it.link = await getLink(it.id, auth); }
        catch (e) { if (e.message === 'CAPTCHA_EXPIRED') { expired = true; } else { it.linkFailed = true; setRowStatus(it.idx, 'error'); } }
        onEach();
      }
    }
    await Promise.all(Array.from({ length: Math.min(LINK_CONCURRENCY, items.length) }, worker));
    if (expired) throw new Error('CAPTCHA_EXPIRED');
    return items.filter(it => it.link);
  }

  // One range via XHR (another extension may wrap fetch and make it drop at high concurrency;
  // XHR measured 100% stable). Retries on transient errors. Returns {chunk} (206) or
  // {full} (server ignored Range -> 200 whole file).
  function fetchRange(url, start, end) {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const go = () => {
        const x = new XMLHttpRequest();
        x.open('GET', url);
        x.setRequestHeader('Range', `bytes=${start}-${end}`);
        x.responseType = 'arraybuffer';
        x.onload = () => {
          if (x.status === 200) resolve({ full: new Uint8Array(x.response) });
          else if (x.status === 206) resolve({ chunk: new Uint8Array(x.response) });
          else retry(new Error('HTTP ' + x.status));
        };
        x.onerror = () => retry(new Error('network'));
        x.send();
      };
      const retry = (e) => { if (++attempt >= CHUNK_RETRIES) reject(e); else setTimeout(go, 400 * attempt); };
      go();
    });
  }

  // Download one file with several parallel ranges (IDM-style), pushing them IN ORDER via
  // pushChunk(bytes). pushChunk is shared by the zip (pt.push) and raw-file (writable.write)
  // paths. Sliding window: fetch at most CHUNK_CONCURRENCY ranges ahead of the write position
  // -> parallel but bounded RAM (~concurrency chunks), unlike a plain p-limit which grows.
  async function pumpChunked(url, size, pushChunk, onBytes, waitWrite) {
    const n = Math.ceil(size / CHUNK_SIZE);
    // probe 1 byte to detect Range support (no serial bandwidth cost).
    const probe = await fetchRange(url, 0, 0);
    if (probe.full) { pushChunk(probe.full); onBytes(probe.full.length); await waitWrite(); return; } // 200: whole file
    const bufs = new Map();
    let nextPush = 0, nextFetch = 0;
    const inflight = new Set();
    const launch = (i) => {
      const start = i * CHUNK_SIZE, end = Math.min(size, start + CHUNK_SIZE) - 1;
      const p = fetchRange(url, start, end).then(res => { bufs.set(i, res.chunk || res.full); }).finally(() => inflight.delete(p));
      inflight.add(p);
    };
    while (nextPush < n) {
      while (nextFetch < n && inflight.size < CHUNK_CONCURRENCY && nextFetch < nextPush + CHUNK_CONCURRENCY) launch(nextFetch++);
      if (bufs.has(nextPush)) {
        const ab = bufs.get(nextPush); bufs.delete(nextPush);
        pushChunk(ab); onBytes(ab.length); await waitWrite();
        nextPush++;
      } else {
        await Promise.race(inflight); // wait for one range to finish, then try to write again
      }
    }
  }

  // Download one raw file (no zip) to a writable, using parallel chunks. Used by per-file retry.
  async function streamOneFile(link, size, writable, onBytes) {
    let writeChain = Promise.resolve();
    const pushChunk = (b) => { const c = b; writeChain = writeChain.then(() => writable.write(c)); };
    if (size >= 2 * CHUNK_SIZE) {
      await pumpChunked(link, size, pushChunk, onBytes, () => writeChain);
    } else {
      const resp = await fetch(link);
      if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
      const reader = resp.body.getReader();
      while (true) { const { done, value } = await reader.read(); if (done) break; pushChunk(value); await writeChain; onBytes(value.length); }
    }
    await writeChain; await writable.close();
  }

  // A zip entry cannot be rolled back once bytes are pushed, so a file whose storage is damaged would
  // leave a truncated entry. Probe it first: 1-byte ranges evenly spaced (gap = max(PROBE_MIN_GAP,
  // size/PROBE_MAX)) plus the last byte, CHUNK_CONCURRENCY at a time, stop at the first failure.
  // Measured on a damaged share file: bytes ~180-256MB of 272MB unreadable (network error), the rest
  // fine. A hole smaller than the gap can be missed (the entry is then truncated, the row marked error).
  async function probeFile(url, size) {
    const gap = Math.max(PROBE_MIN_GAP, Math.ceil(size / PROBE_MAX));
    const offs = []; for (let o = 0; o < size; o += gap) offs.push(o);
    offs.push(size - 1);
    let k = 0, bad = false;
    await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, offs.length) }, async () => {
      while (!bad && k < offs.length) { const o = offs[k++]; try { await fetchRange(url, o, o); } catch (e) { bad = true; } }
    }));
    return !bad;
  }

  // Where the lower-quality copy goes. The transcodes PikPak serves are often MPEG-TS (first byte 0x47,
  // again at 188) and HEVC, not an MP4: measured on a share file whose "480P" media began with 'G@' and
  // 'FFmpeg'. Saved as .mp4 they will not play, so a TS copy gets the .ts extension (VLC/mpv/ffmpeg play it).
  async function altTarget(name, alt) {
    let ts = false;
    try { const r = await fetchRange(alt.url, 0, 376); const b = r.chunk || r.full; ts = !!b && b.length > 188 && b[0] === 0x47 && b[188] === 0x47; } catch (e) { /* keep the original extension */ }
    const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = ts ? '.ts' : (dot > 0 ? name.slice(dot) : '');
    return { name: `${base} (${alt.label})${ext}`, link: alt.url, size: 0, alt: alt.label, ts };
  }

  // ── bundle files into one streamed ZIP on disk ───────────────────────────────
  // items already have .link + .size; onProgress(doneFiles,totalFiles,bytes); setRowProgress(idx,recv,total)
  async function streamZip(items, writable, onProgress, setRowStatus, setRowProgress) {
    const fflate = await ensureFflate();
    let writeChain = Promise.resolve();
    let zipErr = null;
    const zip = new fflate.Zip((err, chunk) => {
      if (err) { zipErr = err; return; }
      if (chunk && chunk.length) { const c = chunk; writeChain = writeChain.then(() => writable.write(c)); }
    });
    const names = uniquify(items.map(it => it.name));
    let bytes = 0, doneFiles = 0; const failed = [], fallback = [];
    // Small files are prefetched whole, FILE_PREFETCH ahead, while the writer handles the current one
    // (even a big chunked one): latency, not bandwidth, dominates small files.
    const pre = new Map();
    const startPre = (j) => {
      const f = items[j];
      if (j >= items.length || pre.has(j) || !(f.size > 0 && f.size < SMALL_FILE)) return;
      pre.set(j, fetchRange(f.link, 0, f.size - 1).then(r => ({ b: r.chunk || r.full }), e => ({ e })));
    };
    for (let i = 0; i < items.length; i++) {
      if (zipErr) throw zipErr;
      for (let j = i; j <= i + FILE_PREFETCH; j++) startPre(j);
      const it = items[i];
      // Target = what actually gets downloaded for this row: the file itself, or (when its storage is
      // damaged and the share offered a transcoded media) that lower-quality copy under a marked name.
      let tgt = { name: names[i], link: it.link, size: it.size };
      if (!pre.has(i) && it.size >= SMALL_FILE && !(await probeFile(it.link, it.size))) {
        if (it.alt && it.alt.url) {
          tgt = await altTarget(names[i], it.alt);
        } else { // damaged and no copy: skip it (no truncated entry in the zip)
          it.dlFailed = true; failed.push(it); setRowStatus(it.idx, 'error'); recordMark(it, false); onProgress(doneFiles, items.length, bytes); continue;
        }
      }
      const pt = new fflate.ZipPassThrough(tgt.name);
      zip.add(pt);
      let recv = 0;
      setRowStatus(it.idx, '0%');
      const onBytes = (nb) => { bytes += nb; recv += nb; onProgress(doneFiles, items.length, bytes); setRowProgress(it.idx, recv, tgt.size); if (tgt.size) { const st = document.querySelector(`[data-st="${it.idx}"]`); if (st && st.textContent !== '✓') st.textContent = Math.min(100, Math.round(recv / tgt.size * 100)) + '%'; } };
      const pushChunk = (b) => pt.push(b, false);
      try {
        if (pre.has(i)) {
          const r = await pre.get(i); pre.delete(i);
          if (r.e) throw r.e;
          pt.push(r.b, false); await writeChain; onBytes(r.b.length);
        } else if (tgt.size >= 2 * CHUNK_SIZE) {
          await pumpChunked(tgt.link, tgt.size, pushChunk, onBytes, () => writeChain);
        } else {
          const resp = await fetch(tgt.link);
          if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
          const reader = resp.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            pt.push(value, false);
            await writeChain; // backpressure: wait for the disk write before reading more -> low RAM
            onBytes(value.length);
          }
        }
        pt.push(new Uint8Array(0), true);
        it.dlFailed = false; doneFiles++; setRowStatus(it.idx, '✓'); recordMark(it, true);
        if (tgt.alt) { fallback.push(it); const st = document.querySelector(`[data-st="${it.idx}"]`); if (st) st.textContent = '✓ ' + tgt.alt; }
      } catch (e) {
        pt.push(new Uint8Array(0), true); // close the entry so the zip stays valid (it is truncated: the row is marked error)
        it.dlFailed = true; failed.push(it); setRowStatus(it.idx, 'error'); recordMark(it, false);
      }
      onProgress(doneFiles, items.length, bytes);
    }
    zip.end();
    await writeChain;
    await writable.close();
    if (zipErr) throw zipErr;
    return { doneFiles, failFiles: failed.length, failed, fallback };
  }

  // fallback when File System Access API is missing: download each file separately (like v1)
  function triggerDownload(url, name) {
    const a = document.createElement('a'); a.href = url; a.download = name || ''; a.style.display = 'none';
    document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 1000);
  }

  // ── global progress indicator: spinning favicon + tab title ──────────────────
  const faviconCtl = (() => {
    let orig = null, link = null, timer = null, angle = 0;
    const iconEl = () => { let l = document.querySelector('link[rel~="icon"]'); if (!l) { l = document.createElement('link'); l.rel = 'icon'; document.head.appendChild(l); } return l; };
    const draw = (done) => {
      const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d');
      x.fillStyle = '#2f6fed'; x.beginPath(); x.arc(16, 16, 15, 0, 2 * Math.PI); x.fill();
      if (done) { x.strokeStyle = '#fff'; x.lineWidth = 3.5; x.lineCap = 'round'; x.beginPath(); x.moveTo(9, 17); x.lineTo(14, 22); x.lineTo(23, 10); x.stroke(); }
      else { x.strokeStyle = 'rgba(255,255,255,.3)'; x.lineWidth = 4; x.beginPath(); x.arc(16, 16, 9, 0, 2 * Math.PI); x.stroke(); x.strokeStyle = '#fff'; x.lineCap = 'round'; x.beginPath(); x.arc(16, 16, 9, angle, angle + Math.PI * 0.6); x.stroke(); }
      return c.toDataURL('image/png');
    };
    return {
      start() { link = iconEl(); if (orig === null) orig = link.getAttribute('href'); angle = 0; clearInterval(timer); timer = setInterval(() => { angle += 0.45; try { link.href = draw(false); } catch (e) {} }, 90); },
      done() { clearInterval(timer); try { if (link) link.href = draw(true); } catch (e) {} setTimeout(() => this.restore(), 6000); },
      restore() { clearInterval(timer); try { if (link && orig !== null) link.href = orig; else if (link && orig === null) link.removeAttribute('href'); } catch (e) {} },
    };
  })();
  const titleCtl = (() => { let orig = null; return { set(t) { if (orig === null) orig = document.title; document.title = t; }, restore() { if (orig !== null) { document.title = orig; orig = null; } } }; })();
  function reqNotif() { try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {} }
  function notify(body) { try { if ('Notification' in window && Notification.permission === 'granted') new Notification('PikPak Multi-Download', { body }); } catch (e) {} }
  function beforeUnloadGuard(e) { e.preventDefault(); e.returnValue = ''; return ''; }

  // List/grid view (remembered in localStorage). Wires the toggle button and applies the class to #pmd-list.
  function getView() { try { return localStorage.getItem('pmd_view') === 'grid' ? 'grid' : 'list'; } catch (e) { return 'list'; } }
  function wireView(overlay) {
    const listEl = overlay.querySelector('#pmd-list'), btn = overlay.querySelector('#pmd-view');
    const apply = (v) => { listEl.classList.toggle('pmd-grid', v === 'grid'); if (btn) btn.textContent = v === 'grid' ? '▤ List' : '▦ Grid'; };
    apply(getView());
    if (btn) btn.onclick = () => { const v = listEl.classList.contains('pmd-grid') ? 'list' : 'grid'; try { localStorage.setItem('pmd_view', v); } catch (e) {} apply(v); };
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  const CSS = `
  #pmd-btn{position:fixed;right:20px;bottom:20px;z-index:99999;background:#2f6fed;color:#fff;border:none;border-radius:24px;padding:12px 18px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}
  #pmd-btn:hover{background:#255ed0}
  #pmd-auto{position:fixed;right:20px;bottom:76px;z-index:99999;background:#e8590c;color:#fff;border:none;border-radius:24px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3)}
  #pmd-auto:hover{background:#c94a08}
  #pmd-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
  #pmd-panel{background:#fff;color:#222;width:min(960px,96vw);max-height:86vh;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;font-family:system-ui,Arial,sans-serif}
  #pmd-view{margin-left:auto;border:1px solid #ccc;background:none;border-radius:6px;padding:3px 9px;font-size:13px;cursor:pointer;color:inherit}
  #pmd-list.pmd-grid{display:flex;flex-wrap:wrap;gap:10px;padding:12px 16px}
  #pmd-list.pmd-grid .pmd-row{flex-direction:column;width:140px;align-items:stretch;padding:0;gap:0;border:1px solid #eee;border-radius:8px;overflow:hidden}
  #pmd-list.pmd-grid .pmd-row input[type=checkbox]{position:absolute;top:6px;left:6px;z-index:2;width:16px;height:16px}
  #pmd-list.pmd-grid .pmd-thumb{width:100%;height:88px;border-radius:0}
  #pmd-list.pmd-grid .pmd-name{padding:6px 8px 0;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;height:34px;line-height:1.4}
  #pmd-list.pmd-grid .pmd-sz{padding:2px 8px 8px;text-align:left;min-width:0}
  #pmd-list.pmd-grid .pmd-st{position:absolute;top:6px;right:8px;background:rgba(0,0,0,.55);color:#fff;border-radius:4px;padding:0 4px;min-width:0}
  #pmd-head{padding:14px 18px;border-bottom:1px solid #eee;display:flex;align-items:center;gap:12px}
  #pmd-head b{font-size:16px}#pmd-head .pmd-sub{color:#888;font-size:13px}
  #pmd-close{margin-left:auto;border:none;background:none;font-size:22px;cursor:pointer;color:#888}
  #pmd-close:disabled{opacity:.3;cursor:not-allowed}
  #pmd-tools{padding:8px 18px;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;gap:14px;font-size:13px}
  #pmd-tools label{cursor:pointer;user-select:none}
  #pmd-list{overflow:auto;padding:4px 0;flex:1}
  .pmd-row{position:relative;display:flex;align-items:center;gap:14px;padding:12px 18px;font-size:14px;border-bottom:1px solid #f7f7f7;cursor:pointer}
  .pmd-row:hover{background:#f6f9ff}
  .pmd-thumb{width:60px;height:60px;object-fit:cover;border-radius:5px;background:#e9e9e9;flex-shrink:0}
  .pmd-row .pmd-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pmd-row .pmd-sz{color:#999;min-width:74px;text-align:right}
  .pmd-row .pmd-st{min-width:48px;text-align:right;font-size:12px}
  .pmd-marks{position:absolute;right:6px;bottom:6px;display:flex;gap:4px;z-index:5;pointer-events:none}
  .pmd-mark{width:22px;height:22px;border-radius:50%;color:#fff;font:700 13px/22px system-ui,Arial,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.45)}
  .pmd-mark-ok{background:#2ca02c}.pmd-mark-err{background:#d62728}
  .pmd-nolink{opacity:.55}.pmd-nolink .pmd-st{color:#999}
  .pmd-play{flex-shrink:0;width:32px;height:32px;border:none;border-radius:50%;background:#2f6fed;color:#fff;font-size:12px;line-height:32px;padding:0 0 0 2px;cursor:pointer}
  .pmd-play:hover{background:#255ed0}.pmd-play:disabled{opacity:.4;cursor:not-allowed}
  #pmd-list.pmd-grid .pmd-play{position:absolute;top:56px;right:6px;width:28px;height:28px;line-height:28px;z-index:2}
  .pmd-prog{position:absolute;left:0;bottom:0;height:3px;width:0;background:#2f6fed;transition:width .15s ease;border-radius:0 2px 2px 0}
  .pmd-prog.done{background:#2ca02c}.pmd-prog.err{background:#d62728}
  .pmd-retry{flex-shrink:0;border:1px solid #d62728;background:none;color:#d62728;border-radius:6px;padding:2px 8px;font-size:12px;cursor:pointer}
  .pmd-retry:hover{background:#d62728;color:#fff}.pmd-retry:disabled{opacity:.4;cursor:not-allowed}
  #pmd-foot{padding:12px 18px;border-top:1px solid #eee;display:flex;align-items:center;gap:12px}
  #pmd-go{background:#2f6fed;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer}
  #pmd-go:disabled{background:#9db8ee;cursor:default}
  #pmd-err{background:#d62728;color:#fff;border:none;border-radius:8px;padding:10px 14px;font-size:13px;font-weight:600;cursor:pointer}
  #pmd-err:disabled{opacity:.5;cursor:default}
  #pmd-status{font-size:13px;color:#666}
  @media (prefers-color-scheme: dark){
    #pmd-panel{background:#22242a;color:#e6e6e6}
    #pmd-head,#pmd-tools,#pmd-foot{border-color:#333}
    .pmd-row{border-color:#2a2c33}.pmd-row:hover{background:#2b2e36}.pmd-thumb{background:#333}
    #pmd-close{color:#aaa}#pmd-view{border-color:#444}
    #pmd-list.pmd-grid .pmd-row{border-color:#333}
  }`;

  let panelOpen = false;
  async function openPanel() {
    if (panelOpen) return;
    panelOpen = true;
    const folderId = currentFolderId();
    const overlay = document.createElement('div');
    overlay.id = 'pmd-overlay';
    overlay.innerHTML = `
      <div id="pmd-panel">
        <div id="pmd-head"><b>Download files</b><span class="pmd-sub" id="pmd-sub">Loading list...</span><button id="pmd-close">×</button></div>
        <div id="pmd-tools"><label><input type="checkbox" id="pmd-all"> Select all</label><span id="pmd-count"></span><button id="pmd-view"></button></div>
        <div id="pmd-list"></div>
        <div id="pmd-foot"><span id="pmd-status"></span><div style="margin-left:auto;display:flex;gap:8px;align-items:center"><button id="pmd-err" style="display:none">↻ Retry failed</button><button id="pmd-go" disabled>Download ZIP</button></div></div>
      </div>`;
    document.body.appendChild(overlay);
    wireView(overlay);
    let busy = false; // downloading -> block closing the modal + reload
    const closeBtn = overlay.querySelector('#pmd-close');
    const close = () => { if (busy) return; overlay.remove(); panelOpen = false; };
    closeBtn.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    const listEl = overlay.querySelector('#pmd-list');
    const subEl = overlay.querySelector('#pmd-sub');
    const goBtn = overlay.querySelector('#pmd-go');
    const errBtn = overlay.querySelector('#pmd-err');
    const statusEl = overlay.querySelector('#pmd-status');
    const countEl = overlay.querySelector('#pmd-count');
    const allBox = overlay.querySelector('#pmd-all');

    if (!folderId) { subEl.textContent = 'Open a specific folder and try again.'; return; }

    let auth, files;
    try { auth = getAuth(); files = await listAll(folderId, auth); }
    catch (e) { subEl.textContent = 'Error: ' + e.message; return; }
    if (!files.length) { subEl.textContent = 'This folder has no files.'; return; }

    const totalSize = files.reduce((s, f) => s + (+f.size || 0), 0);
    subEl.textContent = files.length + ' files · ' + fmtSize(totalSize);
    // Persistent item objects (retry reuses the same ones): carry linkFailed/dlFailed flags.
    const allItems = files.map((f, i) => ({ idx: i, id: f.id, name: f.name, size: +f.size || 0, linkFailed: false, dlFailed: false }));
    files.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'pmd-row';
      const thumb = f.thumbnail_link || f.icon_link || '';
      const icon = f.icon_link || '';
      row.innerHTML =
        `<input type="checkbox" data-i="${i}">` +
        `<img class="pmd-thumb" src="${thumb}" ${icon ? `onerror="this.onerror=null;this.src='${icon}'"` : ''}>` +
        `<span class="pmd-name" title="${f.name.replace(/"/g, '&quot;')}">${f.name}</span>` +
        `<span class="pmd-sz">${fmtSize(f.size)}</span>` +
        `<span class="pmd-st" data-st="${i}"></span>` +
        `<button class="pmd-retry" data-retry="${i}" title="Retry this file" style="display:none">↻</button>` +
        `<div class="pmd-prog" data-prog="${i}"></div>`;
      listEl.appendChild(row);
    });
    const boxes = () => [...listEl.querySelectorAll('input[type=checkbox]')];
    const selected = () => boxes().filter(b => b.checked).map(b => +b.dataset.i);
    const refresh = () => { if (busy) return; const n = selected().length; countEl.textContent = n ? n + ' selected' : ''; goBtn.disabled = !n; goBtn.textContent = n === 1 ? 'Download file' : n ? `Download ZIP (${n})` : 'Download ZIP'; };
    const setRowStatus = (i, txt) => {
      const st = listEl.querySelector(`[data-st="${i}"]`);
      if (st) { st.textContent = txt; const isErr = txt === 'error' || txt === 'captcha'; st.style.color = txt === '✓' ? '#2ca02c' : (isErr ? '#d62728' : '#888'); }
      const pr = listEl.querySelector(`[data-prog="${i}"]`);
      if (pr) { pr.classList.remove('done', 'err'); if (txt === '✓') { pr.classList.add('done'); pr.style.width = '100%'; } else if (txt === 'error' || txt === 'captcha') { pr.classList.add('err'); } }
      const rb = listEl.querySelector(`.pmd-retry[data-retry="${i}"]`);
      if (rb) rb.style.display = (txt === 'error' || txt === 'captcha') ? '' : 'none';
    };
    const setRowProgress = (i, recv, total) => { const pr = listEl.querySelector(`[data-prog="${i}"]`); if (pr && total) pr.style.width = Math.min(100, recv / total * 100) + '%'; };
    const updateErrBtn = () => { const n = allItems.filter(it => it.linkFailed || it.dlFailed).length; errBtn.style.display = n ? '' : 'none'; errBtn.textContent = `↻ Retry failed (${n})`; };
    const resetItem = (it) => { it.linkFailed = false; it.dlFailed = false; const pr = listEl.querySelector(`[data-prog="${it.idx}"]`); if (pr) { pr.classList.remove('done', 'err'); pr.style.width = '0'; } setRowStatus(it.idx, ''); };
    listEl.addEventListener('change', refresh);
    listEl.addEventListener('click', (e) => {
      const b = e.target.closest('.pmd-retry'); if (b && !busy) { retryOne(allItems[+b.dataset.retry]); return; }
      if (busy || e.target.closest('input,button')) return;
      const cb = e.target.closest('.pmd-row')?.querySelector('input[type=checkbox]'); if (cb) { cb.checked = !cb.checked; refresh(); } // click anywhere on the row toggles it
    });
    allBox.onchange = () => { boxes().forEach(b => b.checked = allBox.checked); refresh(); };
    refresh();

    // Lock the UI while downloading (block close/reload) + spin favicon; auto-unlock when done.
    const guarded = async (work) => {
      busy = true; goBtn.disabled = true; allBox.disabled = true; closeBtn.disabled = true; errBtn.disabled = true;
      listEl.querySelectorAll('.pmd-retry').forEach(b => b.disabled = true);
      window.addEventListener('beforeunload', beforeUnloadGuard); faviconCtl.start(); reqNotif();
      try { return await work(); }
      finally {
        busy = false; allBox.disabled = false; closeBtn.disabled = false; errBtn.disabled = false;
        listEl.querySelectorAll('.pmd-retry').forEach(b => b.disabled = false);
        window.removeEventListener('beforeunload', beforeUnloadGuard);
        goBtn.disabled = !selected().length; updateErrBtn();
      }
    };

    // Download a set of files into one ZIP (used by "Download ZIP" and "Retry failed"). Failure flags live on each item.
    async function runZip(dlItems) {
      if (!dlItems.length) return;
      if (!window.showSaveFilePicker) { // fallback: download files one by one (like v1)
        await guarded(async () => {
          for (const it of dlItems) {
            resetItem(it); setRowStatus(it.idx, '...');
            try { const link = await getLink(it.id, auth); triggerDownload(link, it.name); setRowStatus(it.idx, '✓'); it.dlFailed = false; }
            catch (e) { it.dlFailed = true; setRowStatus(it.idx, e.message === 'CAPTCHA_EXPIRED' ? 'captcha' : 'error'); if (e.message === 'CAPTCHA_EXPIRED') { statusEl.textContent = 'Token expired. Reload (F5) and try again.'; break; } }
            await new Promise(r => setTimeout(r, 900));
          }
        });
        return;
      }
      const zipName = (document.title.split('|')[0].trim() || 'pikpak') + '.zip';
      let handle;
      try { handle = await window.showSaveFilePicker({ suggestedName: zipName, types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }] }); }
      catch (e) { return; /* user cancelled the dialog */ }
      const writable = await handle.createWritable();
      dlItems.forEach(resetItem);
      await guarded(async () => {
        try {
          let resolved = 0; statusEl.textContent = `Resolving links... 0/${dlItems.length}`;
          const ready = await resolveLinks(dlItems, auth, () => { statusEl.textContent = `Resolving links... ${++resolved}/${dlItems.length}`; }, setRowStatus);
          if (!ready.length) { try { await writable.abort(); } catch (_) {} statusEl.textContent = 'Could not resolve any link (token expired? reload F5).'; faviconCtl.restore(); titleCtl.restore(); return; }
          const totalBytes = ready.reduce((s, it) => s + (it.size || 0), 0);
          const onProg = (df, tf, by) => {
            const pct = totalBytes ? Math.min(100, Math.round(by / totalBytes * 100)) : 0;
            statusEl.textContent = `Downloading ${df}/${ready.length} files · ${fmtSize(by)}${totalBytes ? ' / ' + fmtSize(totalBytes) : ''} · ${pct}%`;
            titleCtl.set(`⬇ ${pct}% - PikPak`);
          };
          onProg(0, ready.length, 0);
          const { doneFiles } = await streamZip(ready, writable, onProg, setRowStatus, setRowProgress);
          const totFail = dlItems.filter(it => it.linkFailed || it.dlFailed).length;
          const msg = `Done: ${doneFiles} file(s) in ZIP` + (totFail ? `, ${totFail} failed` : '') + '.';
          statusEl.textContent = msg + ' ZIP saved.' + (totFail ? ' Click "Retry failed" to try again.' : '');
          faviconCtl.done(); titleCtl.set('✅ Download complete - PikPak'); notify(msg); setTimeout(() => titleCtl.restore(), 6000);
        } catch (e) {
          try { await writable.abort(); } catch (_) {}
          statusEl.textContent = e.message === 'CAPTCHA_EXPIRED' ? 'Captcha token expired (~5 min). Reload (F5) and try again.' : 'Error: ' + e.message;
          faviconCtl.restore(); titleCtl.restore();
        }
      });
    }

    // Retry one file: download it RAW (no zip) with its real name. The ↻ button on a failed row.
    async function retryOne(it, single) {
      const vb = single ? ['Downloading', 'Done'] : ['Retrying', 'Retry done'];
      if (!window.showSaveFilePicker) {
        await guarded(async () => { resetItem(it); setRowStatus(it.idx, '...'); try { const link = it.link || await getLink(it.id, auth); triggerDownload(link, it.name); setRowStatus(it.idx, '✓'); it.dlFailed = false; } catch (e) { it.dlFailed = true; setRowStatus(it.idx, 'error'); } });
        return;
      }
      let handle;
      try { handle = await window.showSaveFilePicker({ suggestedName: it.name }); } catch (e) { return; }
      const writable = await handle.createWritable();
      resetItem(it);
      await guarded(async () => {
        let recv = 0; const total = it.size;
        const onBytes = (nb) => { recv += nb; setRowProgress(it.idx, recv, total); const st = document.querySelector(`[data-st="${it.idx}"]`); if (st && st.textContent !== '✓') st.textContent = total ? Math.min(100, Math.round(recv / total * 100)) + '%' : fmtSize(recv); };
        statusEl.textContent = `${vb[0]}: ${it.name}`;
        try {
          const link = it.link || await getLink(it.id, auth);
          await streamOneFile(link, total, writable, onBytes);
          it.dlFailed = false; setRowStatus(it.idx, '✓');
          statusEl.textContent = `${vb[1]}: ${it.name}`; faviconCtl.done(); titleCtl.set('✅ Download complete - PikPak'); notify(`${vb[1]}: ${it.name}`); setTimeout(() => titleCtl.restore(), 4000);
        } catch (e) {
          try { await writable.abort(); } catch (_) {}
          it.dlFailed = true; setRowStatus(it.idx, 'error');
          statusEl.textContent = (single ? 'Failed: ' : 'Retry failed: ') + (e.message === 'CAPTCHA_EXPIRED' ? 'token expired, reload F5' : e.message);
          faviconCtl.restore(); titleCtl.restore();
        }
      });
    }

    goBtn.onclick = () => { const items = selected().map(i => allItems[i]); if (items.length === 1) retryOne(items[0], true); else runZip(items); }; // one file: no zip, save it as is
    errBtn.onclick = () => { const f = allItems.filter(it => it.linkFailed || it.dlFailed); if (f.length === 1) retryOne(f[0], true); else runZip(f); };
  }

  // ── SHARE mode (/s/... pages) ────────────────────────────────────────────────
  // The share API requires a PER-FILE captcha that the page signs when you PREVIEW a file;
  // a userscript cannot fake the trusted click needed to open the preview. So: hook
  // share/file_info and harvest the origin link when the USER previews each file, then
  // batch-download (chunk + zip) as usual.
  const isSharePage = () => location.pathname.startsWith('/s/');
  const shareHarvest = new Map(); // file id -> { name, size, url, thumb } (dedup per file, keep the newest url)
  let shareHookInstalled = false, shareSeq = 0;
  // Links belong to the folder they were harvested in. The preview does not change the URL, a folder
  // change does: drop every old link when the path changes (client-side navigation = no reload).
  let harvestPath = location.pathname;
  function syncHarvestFolder() {
    if (location.pathname === harvestPath) return;
    harvestPath = location.pathname;
    shareHarvest.clear();
    if (window.__pmdShareUpdate) window.__pmdShareUpdate();
  }

  // ── auto-capture: while the preview is open, step through every file ──────────
  // The preview shows a "i / n" counter, a .next-button and a thumbnail strip (.preview-bar). Each
  // visited position is recorded once its link is harvested; see autoCapture below.
  let autoRun = false;
  const previewCounter = () => {
    const el = document.querySelector('.control-bar__count');
    const m = el && el.textContent.match(/(\d+)\s*\/\s*(\d+)/);
    return m ? { i: +m[1], n: +m[2] } : null;
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const previewName = () => { const t = document.querySelector('.file-manager-container .header .title'); return t ? t.textContent.trim() : ''; };
  const previewHasLink = () => { const name = previewName(); return !!name && [...shareHarvest.values()].some(h => h.name === name); };
  // Wait until the file now shown has its link: a new link arrived since `seq`, or the header name is
  // already harvested. The app prefetches/caches neighbours' file_info, so a step may fire NO
  // request; cap 3s. Never waits for the video to play.
  async function waitLink(seq) {
    for (let t = 0; t < 20 && autoRun; t++) {
      await sleep(150);
      if (shareSeq !== seq || previewHasLink()) return;
    }
  }
  // Wait for the "i / n" counter to move (or to reach `want`); null if it never does / the preview closed.
  async function counterMoved(from, want) {
    for (let k = 0; k < 20; k++) {
      const c = previewCounter();
      if (!c) return null;
      if (want ? c.i === want : c.i !== from) return c;
      await sleep(100);
    }
    return null;
  }
  async function clickMove(sel) {
    const btn = document.querySelector(sel), from = previewCounter();
    if (!btn || !from || btn.classList.contains('disabled')) return null;
    btn.click();
    return counterMoved(from.i);
  }
  // Jump straight to position idx by clicking its thumbnail in .preview-bar. The strip has no file
  // names, only thumbnails in list order, so position = counter index. Only trusted when the strip
  // holds all n files (a windowed strip -> null, caller walks with next/prev instead).
  async function jumpTo(idx, n) {
    const items = [...document.querySelectorAll('.preview-bar .file-list-item')];
    const it = items.length === n ? items[idx - 1] : null;
    if (!it) return null;
    const t = it.querySelector('.hover-wrap') || it;
    for (const ty of ['mousedown', 'mouseup', 'click']) t.dispatchEvent(new MouseEvent(ty, { bubbles: true, cancelable: true, view: window }));
    return counterMoved(0, idx);
  }
  // Positions 1..n are the "all" list, `done` (position -> name) the visited list. Walk forward with
  // next while the following position is undone; otherwise jump to the smallest undone position.
  // Works from any starting point, never revisits a done position, ends when every position is done.
  async function autoCapture(btn) {
    if (autoRun) { autoRun = false; return; } // second click = stop
    autoRun = true;
    const done = new Map(), missed = [];
    let n = 0, allCollected = false;
    try {
      const c0 = previewCounter();
      if (!c0) return;
      n = c0.n;
      // Positions whose file already has a link (collected earlier, or prefetched by the app) count as done.
      // A strip thumbnail URL contains the file's hash; the payload maps hash -> file. Identical files
      // share a hash (ambiguous) and a windowed strip (length != n) cannot be mapped: both stay undone.
      const hashOf = (src) => (/thumbnails\/([0-9A-Fa-f]+)\//.exec(src) || [])[1];
      const markKnown = () => {
        const exp = nuxtShareFiles(), strip = [...document.querySelectorAll('.preview-bar .file-list-item')];
        if (!exp.length || strip.length !== n) return;
        const byHash = new Map();
        for (const f of exp) if (f.hash) byHash.set(f.hash, (byHash.get(f.hash) || []).concat(f));
        strip.forEach((el, k) => {
          const fs = byHash.get(hashOf((el.querySelector('img') || {}).src || ''));
          if (fs && fs.length === 1 && shareHarvest.has(fs[0].id) && !done.has(k + 1)) done.set(k + 1, fs[0].name);
        });
      };
      const visit = async (seq) => { // current position is on screen: wait for its link, record it
        await waitLink(seq);
        const c = previewCounter(); if (!c) return;
        done.set(c.i, previewName());
        if (!previewHasLink()) missed.push(c.i);
      };
      markKnown();
      { const c = previewCounter(); if (c && !done.has(c.i)) await visit(shareSeq); }
      for (let guard = 0; autoRun && guard < n * 3 + 10; guard++) {
        const c = previewCounter(); if (!c) break;
        markKnown();
        // payload knows every file of the folder: once all have links and it covers the whole preview, stop.
        const exp = nuxtShareFiles();
        if (exp.length >= n && exp.every(f => shareHarvest.has(f.id))) { allCollected = true; break; } // the app prefetches neighbours' file_info, so this can happen before the last position
        let t = (c.i < n && !done.has(c.i + 1)) ? c.i + 1 : 0;
        if (!t) for (let k = 1; k <= n; k++) if (!done.has(k)) { t = k; break; }
        if (!t) break; // all positions done
        btn.textContent = `⏹ Stop (${done.size}/${n})`;
        const seq = shareSeq;
        let nc = t === c.i + 1 ? await clickMove('.next-button') : await jumpTo(t, n);
        if (!nc && t !== c.i + 1) nc = await clickMove(t > c.i ? '.next-button' : '.pre-button'); // strip has no such thumb: walk
        if (!nc) break;
        await visit(seq);
      }
    } finally {
      await sleep(1500); // let in-flight file_info responses land
      autoRun = false;
      const idle = '⏭ Auto-capture all';
      btn.textContent = missed.length ? `${idle} (${missed.length} missed)` : allCollected ? `✓ All ${n} links collected` : idle;
      if (allCollected) setTimeout(() => { if (!autoRun) btn.textContent = idle; }, 5000); // feedback, then back to the normal label
      if (missed.length) console.warn('[PMD] auto-capture: no link for preview positions', missed);
      if (window.__pmdShareUpdate) window.__pmdShareUpdate();
    }
  }
  // Show the button only while a preview is open (has the "i / n" counter).
  function mountAutoButton() {
    let b = document.getElementById('pmd-auto');
    const show = isSharePage() && !!previewCounter();
    if (!show) { if (b && !autoRun) b.remove(); return; }
    if (b) return;
    b = document.createElement('button');
    b.id = 'pmd-auto'; b.textContent = '⏭ Auto-capture all';
    b.title = 'Step through the rest of the files in this preview and collect their links';
    b.onclick = () => autoCapture(b);
    document.body.appendChild(b);
  }
  function installShareHook() {
    if (shareHookInstalled) return; shareHookInstalled = true;
    const of = window.fetch;
    window.fetch = function (input, init) {
      const url = (typeof input === 'string') ? input : (input && input.url);
      const r = of.apply(this, arguments);
      if (url && /share\/detail|share:batch_file_info/.test(url)) { // folder listings (also on client-side navigation) -> folder tree + name->id
        r.then(async (res) => { try { const j = await res.clone().json(); learnEntries(j.files); setTimeout(paintMarks, 600); } catch (e) { /* ignore */ } });
      }
      if (url && /share\/file_info/.test(url)) {
        r.then(async (res) => {
          try {
            const j = await res.clone().json(); const fi = j.file_info || {};
            // Videos: origin link in medias[]. Images (and other plain files): medias is empty,
            // the link is file_info.web_content_link (verified on a .jpg share, 2026-11-14).
            const m0 = (fi.medias || []).find(m => m.is_origin && m.link && m.link.url);
            const o = m0 ? { link: { url: m0.link.url } } : (fi.web_content_link ? { link: { url: fi.web_content_link } } : null);
            if (o && fi.name && fi.id) {
              // Real thumbnail: file_info.thumbnail_link is empty -> take it from the grid card
              // (each card has <img alt="<file name>" src="<real thumbnail>">). Fall back to the generic icon.
              let thumb = fi.thumbnail_link || '';
              if (!thumb) { const im = [...document.querySelectorAll('img[alt]')].find(x => x.getAttribute('alt') === fi.name); if (im) thumb = im.src; }
              if (!thumb) thumb = fi.icon_link || '';
              syncHarvestFolder();
              shareSeq++; // every file_info with a link (even a repeat) = "current file captured" signal for auto-capture
              const before = shareHarvest.size;
              // Lower-quality transcodes of the same file: the fallback when the original's storage is damaged.
              // Prefer h264 (plays everywhere) over hevc, then the larger picture. Label = short side (+ codec if not h264).
              const vid = (m) => m.video || {}, side = (m) => Math.min(vid(m).width || 0, vid(m).height || 0), h264 = (m) => /264|avc/i.test(vid(m).video_codec || '') ? 1 : 0;
              const alts = (fi.medias || []).filter(m => !m.is_origin && m.link && m.link.url).sort((a, b) => (h264(b) - h264(a)) || (side(b) - side(a)));
              const alt = alts[0] ? { url: alts[0].link.url, label: (side(alts[0]) ? side(alts[0]) + 'p' : 'alt') + (h264(alts[0]) || !vid(alts[0]).video_codec ? '' : ' ' + vid(alts[0]).video_codec) } : null;
              shareHarvest.set(fi.id, { name: fi.name, size: +fi.size || 0, url: o.link.url, thumb, alt, parent: fi.parent_id || '' });
              if (shareHarvest.size !== before && window.__pmdShareUpdate) window.__pmdShareUpdate();
            }
          } catch (e) { /* ignore */ }
        });
      }
      return r;
    };
  }

  // ── #__NUXT_DATA__: the folder's first page, server-rendered (ids, names, sizes, REAL thumbnails) ──
  // devalue format: a flat array where object values / array items are indexes into it. It has NO
  // download links (those only come from share/file_info on preview), but it gives the full file list
  // up front so the panel can show every file and auto-capture can tell which links are still missing.
  // It is not updated on client-side navigation, so it is trusted only while it matches the page's cards.
  let nuxtCache = { len: -1, data: {} };
  function nuxtData() {
    try {
      const el = document.querySelector('#__NUXT_DATA__'); if (!el) return {};
      const text = el.textContent;
      if (text.length === nuxtCache.len) return nuxtCache.data; // unchanged since the last parse
      const raw = JSON.parse(text), memo = new Map();
      const rv = (i) => {
        if (i < 0) return undefined; if (memo.has(i)) return memo.get(i);
        const v = raw[i]; if (v === null || typeof v !== 'object') return v;
        if (Array.isArray(v)) {
          if (typeof v[0] === 'string' && /^(Shallow)?(Reactive|Ref)$/.test(v[0])) { const r = rv(v[1]); memo.set(i, r); return r; }
          if (typeof v[0] === 'string' && /^(Set|Map|Date|undefined|NaN|null|Infinity|-Infinity|-0|BigInt|RegExp|Error|Object|Symbol)$/.test(v[0])) return undefined;
          const a = []; memo.set(i, a); v.forEach(x => a.push(rv(x))); return a;
        }
        const o = {}; memo.set(i, o); for (const k in v) o[k] = rv(v[k]); return o;
      };
      const data = (rv(0) || {}).data || {};
      nuxtCache = { len: text.length, data };
      return data;
    } catch (e) { return {}; }
  }
  // Every file/folder entry the server rendered (any kind), for learning the folder tree.
  function nuxtEntries() {
    const out = [], data = nuxtData();
    for (const k in data) for (const f of ((data[k] || {}).files || [])) if (f && f.id && f.name) out.push(f);
    return out;
  }
  function nuxtShareFiles() {
    try {
      const data = nuxtData();
      let best = [];
      for (const k in data) {
        const fs = ((data[k] || {}).files || []).filter(f => f && f.kind === 'drive#file' && f.id && f.name);
        if (fs.length > best.length) best = fs;
      }
      const cards = new Set([...document.querySelectorAll('.file-item a.name')].map(a => a.textContent.trim()));
      if (!best.some(f => cards.has(f.name))) return []; // stale (other folder) or not rendered yet
      return best.map(f => ({ id: f.id, name: f.name, size: +f.size || 0, hash: f.hash || '', parent: f.parent_id || '', thumb: f.thumbnail_link || f.icon_link || '' }));
    } catch (e) { return []; }
  }

  // ── download marks: green ✓ on media already downloaded and on folders that contain one, red ✕ on
  // media whose download failed (and on folders that contain one) ─────────────────────────────────
  // Cards in the page carry no ids, so a card is matched to its file/folder by NAME inside the listing it
  // belongs to (the listing with the most name matches among the ones seen: the page's server-rendered
  // data and the share/detail responses). Folder ancestry is learned from those same listings
  // (folder id -> parent id) and kept in localStorage together with the marks, so ticks survive reloads.
  const MARKS_KEY = 'pmd_marks_v1', TREE_KEY = 'pmd_tree_v1';
  const loadJson = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch (e) { return {}; } };
  const marks = loadJson(MARKS_KEY); // file id -> { p: parent folder id, s: 'ok' | 'err' }
  const tree = loadJson(TREE_KEY);   // folder id -> parent folder id
  const listings = new Map();        // parent folder id -> Map(name -> { id, kind })
  let marksTimer = 0;
  const saveMarks = () => { clearTimeout(marksTimer); marksTimer = setTimeout(() => { try { localStorage.setItem(MARKS_KEY, JSON.stringify(marks)); localStorage.setItem(TREE_KEY, JSON.stringify(tree)); } catch (e) {} }, 400); };
  function learnEntries(files) {
    let changed = false;
    for (const f of files || []) {
      if (!f || !f.id || !f.name) continue;
      const parent = f.parent_id || '';
      if (f.kind === 'drive#folder' && tree[f.id] !== parent) { tree[f.id] = parent; changed = true; }
      let m = listings.get(parent); if (!m) listings.set(parent, m = new Map());
      if (!m.has(f.name)) m.set(f.name, { id: f.id, kind: f.kind });
    }
    if (changed) saveMarks();
  }
  function recordMark(it, ok) {
    if (!it || !it.id || !isSharePage()) return;
    marks[it.id] = { p: it.parent || '', s: ok ? 'ok' : 'err' };
    saveMarks(); paintMarks();
  }
  function paintMarks() {
    if (!isSharePage()) return;
    learnEntries(nuxtEntries());
    const cards = [...document.querySelectorAll('.file-item')];
    if (!cards.length) return;
    const names = cards.map(c => (c.querySelector('a.name')?.textContent || '').trim());
    let best = null, bestN = 0;
    for (const m of listings.values()) { let n = 0; for (const nm of names) if (m.has(nm)) n++; if (n > bestN) { bestN = n; best = m; } }
    const okAnc = new Set(), errAnc = new Set(); // folders that contain a downloaded / a failed file (any depth)
    for (const id in marks) { const mk = marks[id], set = mk.s === 'ok' ? okAnc : errAnc; let p = mk.p, g = 0; while (p && !set.has(p) && g++ < 64) { set.add(p); p = tree[p]; } }
    cards.forEach((c, i) => {
      const e = best && best.get(names[i]);
      let ok = false, err = false, folder = false;
      if (e) {
        folder = e.kind === 'drive#folder';
        if (folder) { ok = okAnc.has(e.id); err = errAnc.has(e.id); } else { const mk = marks[e.id]; ok = !!mk && mk.s === 'ok'; err = !!mk && mk.s === 'err'; }
      }
      const host = c.querySelector('.thumbnail-wrap') || c, sig = (ok ? 'o' : '') + (err ? 'e' : '') + (folder ? 'f' : '');
      if ((host.dataset.pmdMark || '') === sig) return;
      host.dataset.pmdMark = sig;
      const old = host.querySelector(':scope > .pmd-marks'); if (old) old.remove();
      if (!ok && !err) return;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      const box = document.createElement('span'); box.className = 'pmd-marks';
      if (err) { const b = document.createElement('span'); b.className = 'pmd-mark pmd-mark-err'; b.textContent = '✕'; b.title = folder ? 'Contains files that failed to download' : 'Download failed'; box.appendChild(b); }
      if (ok) { const b = document.createElement('span'); b.className = 'pmd-mark pmd-mark-ok'; b.textContent = '✓'; b.title = folder ? 'Contains downloaded files' : 'Downloaded'; box.appendChild(b); }
      host.appendChild(box);
    });
  }

  const pageNames = () => [...document.querySelectorAll('.file-item a.name')].map(a => a.textContent.trim());
  let orderSig = ''; // page order the panel was last rendered with
  let sharePanelOpen = false;
  async function openSharePanel() {
    if (sharePanelOpen) return; sharePanelOpen = true;
    installShareHook();
    const overlay = document.createElement('div');
    overlay.id = 'pmd-overlay';
    overlay.innerHTML = `
      <div id="pmd-panel">
        <div id="pmd-head"><b>Download share (no import)</b><span class="pmd-sub" id="pmd-sub"></span><button id="pmd-close">×</button></div>
        <div id="pmd-hint" style="padding:8px 18px;font-size:12px;color:#888;border-bottom:1px solid #f0f0f0">Every file of this folder is listed. A link is collected when the file is previewed: click <b>▶</b> on a row, or open any preview and press <b>⏭ Auto-capture all</b>. Faded rows have no link yet. Then tick and click <b>Download ZIP</b> (one file: it is saved as is, no zip).</div>
        <div id="pmd-tools"><label><input type="checkbox" id="pmd-all"> Select all</label><span id="pmd-count"></span><button id="pmd-view"></button></div>
        <div id="pmd-list"></div>
        <div id="pmd-foot"><span id="pmd-status"></span><div style="margin-left:auto;display:flex;gap:8px;align-items:center"><button id="pmd-err" style="display:none">↻ Retry failed</button><button id="pmd-go" disabled>Download ZIP</button></div></div>
      </div>`;
    document.body.appendChild(overlay);
    wireView(overlay);
    let busy = false;
    const closeBtn = overlay.querySelector('#pmd-close');
    const close = () => { if (busy) return; overlay.remove(); sharePanelOpen = false; window.__pmdShareUpdate = null; };
    closeBtn.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    const listEl = overlay.querySelector('#pmd-list'), subEl = overlay.querySelector('#pmd-sub');
    const goBtn = overlay.querySelector('#pmd-go'), errBtn = overlay.querySelector('#pmd-err'), statusEl = overlay.querySelector('#pmd-status');
    const countEl = overlay.querySelector('#pmd-count'), allBox = overlay.querySelector('#pmd-all');

    let items = []; // { idx, id, name, size, link ('' = not collected yet), thumb, dlFailed }
    const setRowStatus = (i, txt) => {
      const st = listEl.querySelector(`[data-st="${i}"]`);
      if (st) { st.textContent = txt; const isErr = txt === 'error'; st.style.color = txt === '✓' ? '#2ca02c' : (isErr ? '#d62728' : '#888'); }
      const pr = listEl.querySelector(`[data-prog="${i}"]`);
      if (pr) { pr.classList.remove('done', 'err'); if (txt === '✓') { pr.classList.add('done'); pr.style.width = '100%'; } else if (txt === 'error') pr.classList.add('err'); }
    };
    const setRowProgress = (i, recv, total) => { const pr = listEl.querySelector(`[data-prog="${i}"]`); if (pr && total) pr.style.width = Math.min(100, recv / total * 100) + '%'; };
    const boxes = () => [...listEl.querySelectorAll('input[type=checkbox]')];
    const selectedItems = () => boxes().filter(b => b.checked).map(b => items[+b.dataset.i]).filter(Boolean);
    const refreshGo = () => { if (busy) return; const n = selectedItems().length; countEl.textContent = n ? n + ' selected' : ''; goBtn.disabled = !n; goBtn.textContent = n === 1 ? 'Download file' : n ? `Download ZIP (${n})` : 'Download ZIP'; const linked = items.filter(it => it.link).length; allBox.checked = linked > 0 && n === linked; };
    const updateErr = () => { const n = items.filter(it => it.dlFailed).length; errBtn.style.display = n ? '' : 'none'; errBtn.textContent = `↻ Retry failed (${n})`; };
    // Re-render the list when new links are harvested. NEW files are checked by default; keep existing checkbox state.
    const render = () => {
      if (busy) return; // downloading: don't rebuild (would wipe per-row ✓/error state)
      const prevLinked = new Set(items.filter(it => it.link).map(it => it.id));
      const checkedIds = new Set(boxes().filter(b => b.checked).map(b => b.dataset.id));
      // All files of the folder (payload order), linked or not; then any harvested file outside the payload (later pages).
      const expected = nuxtShareFiles(), seen = new Set();
      items = expected.map((f, i) => { seen.add(f.id); const h = shareHarvest.get(f.id); return { idx: i, id: f.id, name: f.name, size: f.size, link: h ? h.url : '', alt: h ? h.alt : null, parent: f.parent || (h && h.parent) || '', thumb: f.thumb || (h && h.thumb) || '' }; });
      for (const [id, h] of shareHarvest) if (!seen.has(id)) items.push({ idx: items.length, id, name: h.name, size: h.size, link: h.url, alt: h.alt, parent: h.parent, thumb: h.thumb });
      // Same order as the page's own list (it changes with the user's sort); files not rendered there keep payload order after.
      const pos = new Map(); pageNames().forEach((n, i) => { if (!pos.has(n)) pos.set(n, i); });
      items.sort((a, b) => (pos.has(a.name) ? pos.get(a.name) : Infinity) - (pos.has(b.name) ? pos.get(b.name) : Infinity) || a.idx - b.idx);
      items.forEach((it, i) => { it.idx = i; });
      orderSig = pageNames().join('|');
      const linked = items.filter(it => it.link);
      subEl.textContent = (expected.length ? linked.length + '/' + items.length + ' links collected' : linked.length + ' link(s) collected') + ' · ' + fmtSize(linked.reduce((s, it) => s + it.size, 0));
      listEl.innerHTML = items.map(it => {
        const has = !!it.link;
        const chk = has && (!prevLinked.has(it.id) || checkedIds.has(it.id)) ? ' checked' : '';
        return `<div class="pmd-row${has ? '' : ' pmd-nolink'}"><input type="checkbox" data-i="${it.idx}" data-id="${it.id}"${chk}${has ? '' : ' disabled'}>` +
          `<img class="pmd-thumb" src="${it.thumb}">` +
          `<span class="pmd-name" title="${it.name.replace(/"/g, '&quot;')}">${it.name}</span>` +
          `<button class="pmd-play" data-play="${it.id}" title="Preview this file">▶</button>` +
          `<span class="pmd-sz">${fmtSize(it.size)}</span><span class="pmd-st" data-st="${it.idx}">${has ? '' : 'no link'}</span>` +
          `<div class="pmd-prog" data-prog="${it.idx}"></div></div>`;
      }).join('');
      refreshGo();
    };
    listEl.addEventListener('change', refreshGo);
    // Open the page's own preview for a file: click its grid card, hide this panel until the preview closes.
    async function openPreview(id) {
      const it = items.find(x => x.id === id); if (!it) return;
      const card = [...document.querySelectorAll('.file-item')].find(c => (c.querySelector('a.name')?.textContent || '').trim() === it.name);
      if (!card) { statusEl.textContent = 'This file is not in the page list yet - scroll to it, then try again.'; return; }
      overlay.style.display = 'none';
      const tgt = card.querySelector('.thumbnail-wrap') || card;
      for (const t of ['mousedown', 'mouseup', 'click', 'mousedown', 'mouseup', 'click', 'dblclick']) tgt.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, detail: t === 'dblclick' ? 2 : 1, view: window }));
      for (let t = 0; t < 20 && !previewCounter(); t++) await sleep(250); // wait for the preview to open
      while (previewCounter() && overlay.isConnected) await sleep(400);    // ...then for the user to close it
      overlay.style.display = '';
    }
    listEl.addEventListener('click', (e) => {
      if (busy) return;
      const pb = e.target.closest('.pmd-play'); if (pb) { openPreview(pb.dataset.play); return; }
      if (e.target.closest('input,button')) return;
      const cb = e.target.closest('.pmd-row')?.querySelector('input[type=checkbox]'); if (cb) { cb.checked = !cb.checked; refreshGo(); } // click anywhere on the row toggles it
    });
    allBox.onchange = () => { boxes().forEach(b => { if (!b.disabled) b.checked = allBox.checked; }); refreshGo(); };
    window.__pmdShareUpdate = render;
    render();

    const guarded = async (work) => {
      busy = true; goBtn.disabled = true; closeBtn.disabled = true; errBtn.disabled = true; allBox.disabled = true;
      window.addEventListener('beforeunload', beforeUnloadGuard); faviconCtl.start(); reqNotif();
      try { return await work(); }
      finally { busy = false; closeBtn.disabled = false; errBtn.disabled = false; allBox.disabled = false; window.removeEventListener('beforeunload', beforeUnloadGuard); refreshGo(); updateErr(); }
    };

    async function runZipShare(dlItems) {
      if (!dlItems.length) return;
      if (!window.showSaveFilePicker) { await guarded(async () => { for (const it of dlItems) { setRowStatus(it.idx, '...'); try { triggerDownload(it.link, it.name); setRowStatus(it.idx, '✓'); it.dlFailed = false; } catch (e) { it.dlFailed = true; setRowStatus(it.idx, 'error'); } await new Promise(r => setTimeout(r, 900)); } }); return; }
      const zipName = (document.title.split('|')[0].trim() || 'pikpak-share') + '.zip';
      let handle;
      try { handle = await window.showSaveFilePicker({ suggestedName: zipName, types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }] }); } catch (e) { return; }
      const writable = await handle.createWritable();
      await guarded(async () => {
        try {
          const totalBytes = dlItems.reduce((s, it) => s + (it.size || 0), 0);
          const onProg = (df, tf, by) => { const pct = totalBytes ? Math.min(100, Math.round(by / totalBytes * 100)) : 0; statusEl.textContent = `Downloading ${df}/${dlItems.length} · ${fmtSize(by)} / ${fmtSize(totalBytes)} · ${pct}%`; titleCtl.set(`⬇ ${pct}% - PikPak`); };
          onProg(0, dlItems.length, 0);
          const { doneFiles, fallback } = await streamZip(dlItems, writable, onProg, setRowStatus, setRowProgress);
          const totFail = dlItems.filter(it => it.dlFailed).length;
          // PikPak throttles anonymous share downloads after ~1.8GB per link (measured). Larger files break mid-way.
          const bigFail = dlItems.some(it => it.dlFailed && it.size > 1.6 * 1073741824);
          statusEl.textContent = `Done: ${doneFiles} file(s) in ZIP` + (totFail ? `, ${totFail} failed` : '') + '. ZIP saved.' +
            (fallback.length ? ` ${fallback.length} file(s) were unreadable on PikPak's storage; a lower-quality copy was saved instead (the name has the quality; a .ts file is MPEG-TS - open it with VLC or mpv).` : '') +
            (bigFail ? ' Note: PikPak caps anonymous share downloads at ~1.8GB/file - larger files need "Save to PikPak" then download from your Drive.' : '');
          faviconCtl.done(); titleCtl.set('✅ Download complete - PikPak'); notify(`Done: ${doneFiles} file(s)`); setTimeout(() => titleCtl.restore(), 6000);
        } catch (e) { try { await writable.abort(); } catch (_) {} statusEl.textContent = 'Error: ' + e.message; faviconCtl.restore(); titleCtl.restore(); }
      });
    }
    // One file: no zip, save it as is (same probe + lower-quality fallback as the zip path). Probing happens
    // before the save dialog so a fallback copy gets its real name/extension; it takes a second or two, well
    // inside the browser's window for a dialog opened from a click.
    async function runSingleShare(it) {
      let tgt = { name: it.name, link: it.link, size: it.size, alt: '', ts: false };
      statusEl.textContent = `Checking: ${it.name}`;
      try {
        if (it.size >= SMALL_FILE && !(await probeFile(it.link, it.size))) {
          if (!it.alt || !it.alt.url) { it.dlFailed = true; setRowStatus(it.idx, 'error'); recordMark(it, false); statusEl.textContent = "Failed: this file is unreadable on PikPak's storage (part of it cannot be downloaded)."; return; }
          tgt = await altTarget(it.name, it.alt);
        }
      } catch (e) { statusEl.textContent = 'Failed: ' + e.message; return; }
      let handle;
      try { handle = await window.showSaveFilePicker({ suggestedName: tgt.name }); }
      catch (e) { if (e && e.name !== 'AbortError') statusEl.textContent = 'The save dialog was blocked (took too long) - click Download again.'; else statusEl.textContent = ''; return; }
      const writable = await handle.createWritable();
      await guarded(async () => {
        let recv = 0;
        const onBytes = (nb) => {
          recv += nb; setRowProgress(it.idx, recv, tgt.size);
          const pct = tgt.size ? Math.min(100, Math.round(recv / tgt.size * 100)) : 0;
          const st = listEl.querySelector(`[data-st="${it.idx}"]`); if (st) st.textContent = tgt.size ? pct + '%' : fmtSize(recv);
          statusEl.textContent = `Downloading: ${tgt.name} · ${fmtSize(recv)}${tgt.size ? ' / ' + fmtSize(tgt.size) + ' · ' + pct + '%' : ''}`;
          if (tgt.size) titleCtl.set(`⬇ ${pct}% - PikPak`);
        };
        try {
          setRowStatus(it.idx, '0%');
          await streamOneFile(tgt.link, tgt.size, writable, onBytes);
          it.dlFailed = false; setRowStatus(it.idx, '✓'); recordMark(it, true);
          const st = listEl.querySelector(`[data-st="${it.idx}"]`); if (tgt.alt && st) st.textContent = '✓ ' + tgt.alt;
          statusEl.textContent = `Done: ${tgt.name}` + (tgt.alt ? ` - the original is unreadable on PikPak's storage, saved a lower-quality copy instead${tgt.ts ? ' (MPEG-TS: open it with VLC or mpv)' : ''}.` : '');
          faviconCtl.done(); titleCtl.set('✅ Download complete - PikPak'); notify(`Done: ${tgt.name}`); setTimeout(() => titleCtl.restore(), 6000);
        } catch (e) {
          try { await writable.abort(); } catch (_) {}
          it.dlFailed = true; setRowStatus(it.idx, 'error'); recordMark(it, false);
          statusEl.textContent = 'Failed: ' + e.message; faviconCtl.restore(); titleCtl.restore();
        }
      });
    }
    const runShare = (list) => (list.length === 1 && window.showSaveFilePicker) ? runSingleShare(list[0]) : runZipShare(list);
    goBtn.onclick = () => { render(); runShare(selectedItems()); }; // render() -> newest urls; only download ticked files
    errBtn.onclick = () => runShare(items.filter(it => it.dlFailed));
  }

  // ── mount ──────────────────────────────────────────────────────────────────
  function mountButton() {
    if (isSharePage()) { syncHarvestFolder(); installShareHook(); mountAutoButton(); paintMarks(); if (window.__pmdShareUpdate && pageNames().join('|') !== orderSig) window.__pmdShareUpdate(); } // sort changed outside -> re-sync the panel // start harvesting even before the panel opens
    if (document.getElementById('pmd-btn')) return;
    const b = document.createElement('button');
    b.id = 'pmd-btn';
    b.textContent = isSharePage() ? '⬇ Download share' : '⬇ Download';
    b.onclick = isSharePage() ? openSharePanel : openPanel;
    document.body.appendChild(b);
  }
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  mountButton();
  setInterval(mountButton, 2000);
})();
