// ==UserScript==
// @name         PikPak Multi-Download
// @namespace    dunggramer.pikpak
// @version      2.7.2
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
    let bytes = 0, doneFiles = 0; const failed = [];
    for (let i = 0; i < items.length; i++) {
      if (zipErr) throw zipErr;
      const it = items[i];
      const pt = new fflate.ZipPassThrough(names[i]);
      zip.add(pt);
      let recv = 0;
      setRowStatus(it.idx, '0%');
      const onBytes = (nb) => { bytes += nb; recv += nb; onProgress(doneFiles, items.length, bytes); setRowProgress(it.idx, recv, it.size); if (it.size) { const st = document.querySelector(`[data-st="${it.idx}"]`); if (st && st.textContent !== '✓') st.textContent = Math.min(100, Math.round(recv / it.size * 100)) + '%'; } };
      const pushChunk = (b) => pt.push(b, false);
      try {
        if (it.size >= 2 * CHUNK_SIZE) {
          await pumpChunked(it.link, it.size, pushChunk, onBytes, () => writeChain);
        } else {
          const resp = await fetch(it.link);
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
        it.dlFailed = false; doneFiles++; setRowStatus(it.idx, '✓');
      } catch (e) {
        pt.push(new Uint8Array(0), true); // close the entry so the zip stays valid
        it.dlFailed = true; failed.push(it); setRowStatus(it.idx, 'error');
      }
      onProgress(doneFiles, items.length, bytes);
    }
    zip.end();
    await writeChain;
    await writable.close();
    if (zipErr) throw zipErr;
    return { doneFiles, failFiles: failed.length, failed };
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
  .pmd-row{position:relative;display:flex;align-items:center;gap:12px;padding:6px 18px;font-size:13px;border-bottom:1px solid #f7f7f7}
  .pmd-row:hover{background:#f6f9ff}
  .pmd-thumb{width:46px;height:46px;object-fit:cover;border-radius:5px;background:#e9e9e9;flex-shrink:0}
  .pmd-row .pmd-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pmd-row .pmd-sz{color:#999;min-width:74px;text-align:right}
  .pmd-row .pmd-st{min-width:48px;text-align:right;font-size:12px}
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
    const refresh = () => { if (busy) return; const n = selected().length; countEl.textContent = n ? n + ' selected' : ''; goBtn.disabled = !n; goBtn.textContent = n ? `Download ZIP (${n})` : 'Download ZIP'; };
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
    listEl.addEventListener('click', (e) => { const b = e.target.closest('.pmd-retry'); if (b && !busy) retryOne(allItems[+b.dataset.retry]); });
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
    async function retryOne(it) {
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
        statusEl.textContent = `Retrying: ${it.name}`;
        try {
          const link = it.link || await getLink(it.id, auth);
          await streamOneFile(link, total, writable, onBytes);
          it.dlFailed = false; setRowStatus(it.idx, '✓');
          statusEl.textContent = `Retry done: ${it.name}`; faviconCtl.done(); titleCtl.set('✅ Download complete - PikPak'); notify(`Retry done: ${it.name}`); setTimeout(() => titleCtl.restore(), 4000);
        } catch (e) {
          try { await writable.abort(); } catch (_) {}
          it.dlFailed = true; setRowStatus(it.idx, 'error');
          statusEl.textContent = 'Retry failed: ' + (e.message === 'CAPTCHA_EXPIRED' ? 'token expired, reload F5' : e.message);
          faviconCtl.restore(); titleCtl.restore();
        }
      });
    }

    goBtn.onclick = () => { const items = selected().map(i => allItems[i]); runZip(items); };
    errBtn.onclick = () => runZip(allItems.filter(it => it.linkFailed || it.dlFailed));
  }

  // ── SHARE mode (/s/... pages) ────────────────────────────────────────────────
  // The share API requires a PER-FILE captcha that the page signs when you PREVIEW a file;
  // a userscript cannot fake the trusted click needed to open the preview. So: hook
  // share/file_info and harvest the origin link when the USER previews each file, then
  // batch-download (chunk + zip) as usual.
  const isSharePage = () => location.pathname.startsWith('/s/');
  const shareHarvest = new Map(); // file id -> { name, size, url, thumb } (dedup per file, keep the newest url)
  let shareHookInstalled = false;
  function installShareHook() {
    if (shareHookInstalled) return; shareHookInstalled = true;
    const of = window.fetch;
    window.fetch = function (input, init) {
      const url = (typeof input === 'string') ? input : (input && input.url);
      const r = of.apply(this, arguments);
      if (url && /share\/file_info/.test(url)) {
        r.then(async (res) => {
          try {
            const j = await res.clone().json(); const fi = j.file_info || {};
            const o = (fi.medias || []).find(m => m.is_origin && m.link && m.link.url);
            if (o && fi.name && fi.id) {
              // Real thumbnail: file_info.thumbnail_link is empty -> take it from the grid card
              // (each card has <img alt="<file name>" src="<real thumbnail>">). Fall back to the generic icon.
              let thumb = fi.thumbnail_link || '';
              if (!thumb) { const im = [...document.querySelectorAll('img[alt]')].find(x => x.getAttribute('alt') === fi.name); if (im) thumb = im.src; }
              if (!thumb) thumb = fi.icon_link || '';
              const before = shareHarvest.size;
              shareHarvest.set(fi.id, { name: fi.name, size: +fi.size || 0, url: o.link.url, thumb });
              if (shareHarvest.size !== before && window.__pmdShareUpdate) window.__pmdShareUpdate();
            }
          } catch (e) { /* ignore */ }
        });
      }
      return r;
    };
  }

  let sharePanelOpen = false;
  async function openSharePanel() {
    if (sharePanelOpen) return; sharePanelOpen = true;
    installShareHook();
    const overlay = document.createElement('div');
    overlay.id = 'pmd-overlay';
    overlay.innerHTML = `
      <div id="pmd-panel">
        <div id="pmd-head"><b>Download share (no import)</b><span class="pmd-sub" id="pmd-sub"></span><button id="pmd-close">×</button></div>
        <div id="pmd-hint" style="padding:8px 18px;font-size:12px;color:#888;border-bottom:1px solid #f0f0f0"><b>Preview</b> each file you want - its link is collected here automatically (use the thumbnail strip in the preview to flip through quickly). Then tick and click <b>Download ZIP</b>.</div>
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

    let items = []; // { idx, id, name, size, link, thumb, dlFailed }
    const setRowStatus = (i, txt) => {
      const st = listEl.querySelector(`[data-st="${i}"]`);
      if (st) { st.textContent = txt; const isErr = txt === 'error'; st.style.color = txt === '✓' ? '#2ca02c' : (isErr ? '#d62728' : '#888'); }
      const pr = listEl.querySelector(`[data-prog="${i}"]`);
      if (pr) { pr.classList.remove('done', 'err'); if (txt === '✓') { pr.classList.add('done'); pr.style.width = '100%'; } else if (txt === 'error') pr.classList.add('err'); }
    };
    const setRowProgress = (i, recv, total) => { const pr = listEl.querySelector(`[data-prog="${i}"]`); if (pr && total) pr.style.width = Math.min(100, recv / total * 100) + '%'; };
    const boxes = () => [...listEl.querySelectorAll('input[type=checkbox]')];
    const selectedItems = () => boxes().filter(b => b.checked).map(b => items[+b.dataset.i]).filter(Boolean);
    const refreshGo = () => { if (busy) return; const n = selectedItems().length; countEl.textContent = n ? n + ' selected' : ''; goBtn.disabled = !n; goBtn.textContent = n ? `Download ZIP (${n})` : 'Download ZIP'; allBox.checked = items.length > 0 && n === items.length; };
    const updateErr = () => { const n = items.filter(it => it.dlFailed).length; errBtn.style.display = n ? '' : 'none'; errBtn.textContent = `↻ Retry failed (${n})`; };
    // Re-render the list when new links are harvested. NEW files are checked by default; keep existing checkbox state.
    const render = () => {
      if (busy) return; // downloading: don't rebuild (would wipe per-row ✓/error state)
      const prevIds = new Set(items.map(it => it.id));
      const checkedIds = new Set(boxes().filter(b => b.checked).map(b => b.dataset.id));
      items = [...shareHarvest.entries()].map(([id, h], i) => ({ idx: i, id, name: h.name, size: h.size, link: h.url, thumb: h.thumb }));
      subEl.textContent = items.length + ' link(s) collected · ' + fmtSize(items.reduce((s, it) => s + it.size, 0));
      listEl.innerHTML = items.map(it => {
        const chk = (!prevIds.has(it.id) || checkedIds.has(it.id)) ? ' checked' : '';
        return `<div class="pmd-row"><input type="checkbox" data-i="${it.idx}" data-id="${it.id}"${chk}>` +
          `<img class="pmd-thumb" src="${it.thumb}">` +
          `<span class="pmd-name" title="${it.name.replace(/"/g, '&quot;')}">${it.name}</span>` +
          `<span class="pmd-sz">${fmtSize(it.size)}</span><span class="pmd-st" data-st="${it.idx}"></span>` +
          `<div class="pmd-prog" data-prog="${it.idx}"></div></div>`;
      }).join('');
      refreshGo();
    };
    listEl.addEventListener('change', refreshGo);
    allBox.onchange = () => { boxes().forEach(b => b.checked = allBox.checked); refreshGo(); };
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
          const { doneFiles } = await streamZip(dlItems, writable, onProg, setRowStatus, setRowProgress);
          const totFail = dlItems.filter(it => it.dlFailed).length;
          // PikPak throttles anonymous share downloads after ~1.8GB per link (measured). Larger files break mid-way.
          const bigFail = dlItems.some(it => it.dlFailed && it.size > 1.6 * 1073741824);
          statusEl.textContent = `Done: ${doneFiles} file(s) in ZIP` + (totFail ? `, ${totFail} failed` : '') + '. ZIP saved.' +
            (bigFail ? ' Note: PikPak caps anonymous share downloads at ~1.8GB/file - larger files need "Save to PikPak" then download from your Drive.' : '');
          faviconCtl.done(); titleCtl.set('✅ Download complete - PikPak'); notify(`Done: ${doneFiles} file(s)`); setTimeout(() => titleCtl.restore(), 6000);
        } catch (e) { try { await writable.abort(); } catch (_) {} statusEl.textContent = 'Error: ' + e.message; faviconCtl.restore(); titleCtl.restore(); }
      });
    }
    goBtn.onclick = () => { render(); runZipShare(selectedItems()); }; // render() -> newest urls; only download ticked files
    errBtn.onclick = () => runZipShare(items.filter(it => it.dlFailed));
  }

  // ── mount ──────────────────────────────────────────────────────────────────
  function mountButton() {
    if (isSharePage()) installShareHook(); // start harvesting even before the panel opens
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
