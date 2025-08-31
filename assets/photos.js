/* assets/photos.js — enhanced folder UI with nested dropdowns, open buttons, and zip downloads */
(function () {
  // --- Helpers ---
  const q = s => document.querySelector(s);
  const qa = s => Array.from(document.querySelectorAll(s));

  function create(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const k in props) {
      if (k === 'class') el.className = props[k];
      else if (k.startsWith('data-')) el.setAttribute(k, props[k]);
      else if (k === 'html') el.innerHTML = props[k];
      else el[k] = props[k];
    }
    for (const c of children) {
      if (c == null) continue;
      if (typeof c === 'string') el.appendChild(document.createTextNode(c));
      else el.appendChild(c);
    }
    return el;
  }

  // Basic concurrency mapper used by zipping code
  async function mapWithConcurrency(list, mapper, concurrency = 4) {
    const results = [];
    const executing = new Set();
    for (const item of list) {
      const p = (async () => mapper(item))();
      results.push(p);
      executing.add(p);
      const cleanup = () => executing.delete(p);
      p.then(cleanup).catch(cleanup);
      if (executing.size >= concurrency) await Promise.race(executing);
    }
    return Promise.all(results);
  }

  async function fetchBlob(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Network error');
    return res.blob();
  }

  // Lazy load JSZip script
  async function ensureJSZip() {
    if (window.JSZip) return window.JSZip;
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.integrity = 'sha512-YVn2VShS5XYvHVB57hI10PvHFEw1Wwx5EPq04xh9R8uC05+hE+5p+tAkV3BHLwXj8qG5aa4T6knk4rPGVt+Wg==';
      s.crossOrigin = 'anonymous';
      s.referrerPolicy = 'no-referrer';
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => {
        console.error('Failed to load JSZip');
        reject(new Error('Failed to load JSZip library'));
      };
      document.head.appendChild(s);
    });
  }

  // Try several candidate locations for a folder's prebuilt ZIP and return the first that exists (or null).
  async function findAvailableZip(candidates) {
    for (const c of candidates) {
      try {
        const res = await fetch(c, { method: 'HEAD' });
        if (res && res.ok) return c;
      } catch (err) {
        // ignore and try next
      }
    }
    return null;
  }

  // --- Data discovery ---
  // Build a simple manifest by listing folders present in the /photos directory.
  // We'll attempt to fetch a generated `manifest.json` in /photos/ (created by this patch).
  async function loadManifest() {
    try {
      const res = await fetch('/photos/manifest.json');
      if (!res.ok) throw new Error('no manifest');
      return await res.json();
    } catch (err) {
      console.warn('manifest not found, attempting heuristic build');
      // fallback: read folder links from existing server index by fetching /photos/ and parsing anchor hrefs
      try {
        const res = await fetch('/photos/');
        const txt = await res.text();
        const div = document.createElement('div');
        div.innerHTML = txt;
        const links = Array.from(div.querySelectorAll('a')).map(a => a.getAttribute('href')).filter(Boolean);
        const folders = links.filter(h => h.endsWith('/')).map(h => ({ name: h.replace(/\//, ''), path: '/photos/' + h.replace(/\//, '') + '/' }));
        return { folders };
      } catch (err2) {
        return { folders: [] };
      }
    }
  }

  // --- UI components ---
  function folderTile(name, path, node) {
    const tile = create('div', { class: 'folder-tile' });
    const left = create('div', { class: 'folder-left' });
    const title = create('div', { class: 'folder-title' }, name);
    const actions = create('div', { class: 'folder-actions' });

    const toggle = create('button', { class: 'icon-btn folder-expand', title: 'Show contents' }, '▸');
    const openBtn = create('a', { class: 'btn folder-open', href: path, title: 'Open folder page' }, 'Open');
    // prefer server-provided zip file named <FolderName>.zip inside the folder; fall back to client zipping
    const zipHref = path + (encodeURIComponent(name) || 'folder') + '.zip';
    const zipBtn = create('a', {
      class: 'btn btn-secondary folder-zip',
      title: 'Download ZIP for this folder',
      href: zipHref,
      download: (name || 'photos') + '.zip'
    }, 'Download ZIP');

    left.appendChild(toggle);
    left.appendChild(title);
    actions.appendChild(zipBtn);
    actions.appendChild(openBtn);

    tile.appendChild(left);
    tile.appendChild(actions);

    const contentWrap = create('div', { class: 'folder-contents hidden' });
    tile.appendChild(contentWrap);

    // events
    toggle.addEventListener('click', async () => {
      const opened = contentWrap.classList.toggle('hidden');
      // rotate arrow
      toggle.classList.toggle('expanded');
      if (!opened && !contentWrap.dataset.loaded) {
        // load contents
        try {
          const data = await loadFolderIndex(path);
          renderFolderContents(contentWrap, data, path);
          contentWrap.dataset.loaded = '1';
        } catch (err) {
          contentWrap.innerHTML = '<em>Failed to load contents</em>';
        }
      }
    });

    zipBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();

      // Special handling for minnesota folder - always download minnesota.zip
      if (name && name.toLowerCase() === 'minnesota') {
        const minnesotaZipPath = '/photos/minnesota/minnesota.zip';

        try {
          // Check if the specific minnesota.zip file exists
          const response = await fetch(minnesotaZipPath, { method: 'HEAD' });

          if (response.ok) {
            // File exists, trigger download with proper headers
            const a = document.createElement('a');
            a.href = minnesotaZipPath;
            a.download = 'minnesota.zip';
            document.body.appendChild(a);
            a.click();
            a.remove();
            return;
          }
        } catch (error) {
          console.warn('Could not access minnesota.zip:', error);
        }
      }

      // Build sensible candidate locations for a prebuilt zip. Some setups put the zip inside the folder
      // named after the folder, or in an `altfiles/` or the parent `photos/` root. Probe them and use
      // the first that responds OK. If none found, fallback to client-side zipping.
      const folderName = encodeURIComponent(name || 'photos');
      const candidates = [
        path + folderName + '.zip',               // /photos/Foo/Foo.zip
        path + folderName + '.ZIP',               // case variants
        '/photos/' + folderName + '.zip',         // /photos/Foo.zip at root
        '/photos/altfiles/' + folderName + '.zip' // altfiles location used in this repo
      ];
      const found = await findAvailableZip(candidates);
      if (found) {
        const a = document.createElement('a'); a.href = found; a.download = zipBtn.getAttribute('download') || ''; document.body.appendChild(a); a.click(); a.remove();
        return;
      }
      // fallback: build zip client-side
      createZipFromFolder(path, name);
    });

    return tile;
  }

  function renderFolderContents(container, data, basePath) {
    container.innerHTML = '';
    if (!data) {
      container.innerHTML = '<div class=\"folder-error\">No content available</div>';
      return;
    }

    const list = create('div', { class: 'folder-list' });

    if (data.folders && data.folders.length > 0) {
      data.folders.forEach(f => {
        const nested = folderTile(f.name, basePath + f.name + '/', null);
        list.appendChild(nested);
      });
    }

    if (data.files && data.files.length > 0) {
      data.files.forEach(f => {
        const item = create('div', { class: 'folder-file' });
        const img = create('img', {
          src: f.thumb || (basePath + f),
          alt: f,
          loading: 'lazy',
          onerror: 'this.src=\"/assets/images/placeholder.png\"'
        });
        const meta = create('div', { class: 'file-meta' }, f);
        const actions = create('div', { class: 'file-actions' });
        const open = create('a', { class: 'btn btn-secondary', href: basePath + f, target: '_blank' }, 'View');
        const download = create('a', {
          class: 'btn btn-cta',
          href: basePath + f,
          download: f
        }, 'Download');

        actions.appendChild(open);
        actions.appendChild(download);
        item.appendChild(img);
        item.appendChild(meta);
        item.appendChild(actions);
        list.appendChild(item);
      });
    } else if (!data.folders || data.folders.length === 0) {
      list.innerHTML = '<div class=\"folder-empty\">This folder is empty</div>';
    }

    container.appendChild(list);
  }

  // Attempt to load a folder index.json placed next to folder by server/patch; otherwise fallback to naive listing by fetching folder URL and parsing anchors.
  async function loadFolderIndex(folderPath) {
    try {
      const res = await fetch(folderPath + 'index.json');
      if (res.ok) return await res.json();
    } catch (err) {}
    // fallback: parse the directory listing
    const res = await fetch(folderPath);
    const txt = await res.text();
    const div = document.createElement('div');
    div.innerHTML = txt;
    const anchors = Array.from(div.querySelectorAll('a'));
    const files = [];
    const folders = [];
    anchors.forEach(a => {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('?') || href === '../') return;
      if (href.endsWith('/')) {
        // folder
        const name = href.replace(/\//, '');
        folders.push({ name });
      } else {
        files.push(href);
      }
    });

    // If there were no anchor-based files (many static index.html pages list <img> tags
    // instead of producing a directory listing), also look for <img src="..." /> tags
    // and convert them into file entries (filename only) so the gallery can render.
    if (files.length === 0) {
      const imgs = Array.from(div.querySelectorAll('img'))
        .map(img => img.getAttribute('src'))
        .filter(Boolean)
        .map(s => s.replace(/^\/\//, '')) // remove leading ./  
        .map(s => s.replace(/^.*\//, ''))  // collapse to filename
        .filter(s => !s.startsWith('data:'));
      if (imgs.length > 0) imgs.forEach(i => files.push(i));
    }

    return { files, folders };
  }

  // Build zip for a folder path by fetching all files in that folder (non-recursive)
  async function createZipFromFolder(folderPath, folderName) {
    let hasZip = true;
    try { await ensureJSZip(); } catch (err) { hasZip = false; }
    const res = await fetch(folderPath);
    if (!res.ok) { alert('Failed to list folder'); return; }
    const txt = await res.text();
    const div = document.createElement('div');
    div.innerHTML = txt;
    const anchors = Array.from(div.querySelectorAll('a')).map(a => a.getAttribute('href')).filter(Boolean).filter(h => !h.endsWith('../'));
    const files = anchors.filter(h => !h.endsWith('/'));

    if (files.length === 0) { alert('No files found to zip'); return; }
    // If JSZip not available, fallback to sequential file downloads (one-by-one)
    if (!hasZip) {
      // Informative UX
      try { showGlobalProgress().value = 0; } catch (e) {}
      await downloadFilesSequentially(files, folderPath, folderName);
      try { showGlobalProgress().value = 100; } catch (e) {}
      return;
    }

    const zip = new JSZip();
    const folder = zip.folder(folderName || 'photos');

    const progressBar = showGlobalProgress();
    let completed = 0;

    await mapWithConcurrency(files, async (f) => {
      try {
        const url = folderPath + f;
        const blob = await fetchBlob(url);
        folder.file(f.replace(/^.*\//, ''), blob);
      } catch (err) {
        console.warn('skip', f, err);
      } finally {
        completed += 1; progressBar.value = Math.round((completed / files.length) * 100);
      }
    }, 4);

    const content = await zip.generateAsync({ type: 'blob' }, meta => { if (meta.percent) progressBar.value = Math.round(meta.percent); });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a'); a.href = url; a.download = (folderName || 'photos') + '.zip'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    progressBar.value = 100;
  }

  // Sequentially trigger downloads for a list of files. Not a zip, but reliable fallback.
  async function downloadFilesSequentially(files, basePath, folderName) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const url = basePath + f;
      const a = document.createElement('a');
      a.href = url;
      // try to preserve folder context in suggested filename
      const filename = (folderName ? (folderName.replace(/\s+/g, '_') + '_') : '') + f.replace(/^.*\//, '');
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // slight pause to avoid overwhelming browser with immediate clicks
      await new Promise(r => setTimeout(r, 250));
    }
  }

  function showGlobalProgress() {
    let bar = q('#global-zip-progress');
    if (!bar) {
      const wrap = create('div', { class: 'zip-progress-wrap container' });
      bar = create('progress', { id: 'global-zip-progress' }); bar.max = 100; bar.value = 0; bar.style.width = '100%';
      wrap.appendChild(bar);
      q('#zip-global-placeholder').appendChild(wrap);
    }
    return q('#global-zip-progress');
  }

  // --- render root folders ---
  async function renderRoot() {
    const root = q('#folders-root');
    if (!root) return;
    root.innerHTML = '';
    const manifest = await loadManifest();
    const folders = manifest.folders || [];
    if (folders.length === 0) {
      root.appendChild(create('div', {}, 'No folders found'));
      return;
    }
    folders.forEach(f => {
      const tile = folderTile(f.name || f, '/photos/' + (f.name || f) + '/');
      root.appendChild(tile);
    });
  }

  // global "download all visible" — gather displayed folder entries and zip them per-folder into a single zip
  async function downloadAllVisible() {
    let hasZip = true;
    try { await ensureJSZip(); } catch (err) { hasZip = false; }
    const root = q('#folders-root');
    const tiles = Array.from(root.querySelectorAll('.folder-tile'));
    const gprogress = showGlobalProgress();
    let totalFiles = 0;
    const tasks = [];
    for (const t of tiles) {
      const name = t.querySelector('.folder-title').textContent.trim();
      const path = t.querySelector('.folder-open').href.replace(window.location.origin, '');
      // list files
      const res = await fetch(path);
      if (!res.ok) continue;
      const txt = await res.text(); const div = document.createElement('div'); div.innerHTML = txt;
      const anchors = Array.from(div.querySelectorAll('a')).map(a => a.getAttribute('href')).filter(Boolean).filter(h => !h.endsWith('../'));
      const files = anchors.filter(h => !h.endsWith('/'));
      totalFiles += files.length;
      for (const f of files) tasks.push({ path, file: f, folder: name });
    }
    if (tasks.length === 0) { alert('No files found'); return; }

    if (!hasZip) {
      // fallback: sequentially trigger downloads per-file
      let done = 0;
      for (const t of tasks) {
        try {
          const a = document.createElement('a');
          a.href = t.path + t.file;
          a.download = (t.folder ? (t.folder.replace(/\s+/g, '_') + '_') : '') + t.file.replace(/^.*\//, '');
          a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove();
        } catch (err) { console.warn('download skip', t, err); }
        done += 1; gprogress.value = Math.round((done / tasks.length) * 100);
        await new Promise(r => setTimeout(r, 200));
      }
      gprogress.value = 100;
      return;
    }

    const zip = new JSZip();
    let done = 0;
    await mapWithConcurrency(tasks, async t => {
      try {
        const blob = await fetchBlob(t.path + t.file);
        zip.folder(t.folder).file(t.file.replace(/^.*\//, ''), blob);
      } catch (err) { console.warn('skip', t, err); }
      finally { done += 1; gprogress.value = Math.round((done / tasks.length) * 100); }
    }, 4);
    const content = await zip.generateAsync({ type: 'blob' }, meta => { if (meta.percent) gprogress.value = Math.round(meta.percent); });
    const url = URL.createObjectURL(content); const a = document.createElement('a'); a.href = url; a.download = 'photos-all.zip'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    gprogress.value = 100;
  }

  // expose helper for folder pages to render their own content
  window.photosHelpers = window.photosHelpers || {};
  window.photosHelpers.renderFolderContents = renderFolderContents;
  window.photosHelpers.loadFolderIndex = loadFolderIndex;
  window.photosHelpers.createZipFromFolder = createZipFromFolder;
  window.photosHelpers.ensureJSZip = ensureJSZip;

  // --- render a dedicated folder page (subpage) ---
  // options: { topCount: number }
  async function renderFolderPage(basePath, containerSelector = '#folder-page-root', options = {}) {
    const container = document.querySelector(containerSelector);
    if (!container) return;
    const data = await loadFolderIndex(basePath);
    const files = (data && data.files) ? data.files.filter(f => !f.endsWith('/')) : [];
    // set header background to first image if possible
    const header = document.querySelector('.photos-header');
    if (header) {
      const rep = files[0] ? (basePath + files[0]) : header.style.backgroundImage;
      if (files[0]) header.style.backgroundImage = `url('${rep}')`;
      // ensure header content shows folder name if present
      const titleEl = header.querySelector('.header-content .h1') || header.querySelector('.h1');
      if (titleEl) {
        // prefer folder name from path
        const name = decodeURIComponent((basePath.replace(/\//, '')).split('/').pop());
        titleEl.textContent = name;
      }
    }

    // build the page layout
    container.innerHTML = '';
    const topCount = typeof options.topCount === 'number' ? options.topCount : Math.min(8, Math.max(4, Math.floor((files.length)/4) * 2 || 4));
    const topFiles = files.slice(0, topCount);
    const rest = files.slice(topCount);

    // top strip (overlaps header visually) -> will be positioned via CSS by negative margin
    const topStrip = create('div', { class: 'folder-page-topstrip container' });
    // add top controls (Download ZIP for this folder)
    const topControls = create('div', { class: 'folder-page-top-controls' });
    const folderName = decodeURIComponent((basePath.replace(/\//, '')).split('/').pop());
    const zipHref = basePath + encodeURIComponent(folderName) + '.zip';
    const topZip = create('a', { class: 'btn btn-secondary', href: zipHref, download: (folderName || 'photos') + '.zip', title: 'Download ZIP for this folder' }, 'Download ZIP');
    topControls.appendChild(topZip);
    topStrip.appendChild(topControls);
    topFiles.forEach(f => {
      const thumb = create('a', { class: 'folder-page-thumb', href: basePath + f, target: '_blank' });
      const img = create('img', { src: basePath + f, alt: f, loading: 'lazy' });
      thumb.appendChild(img);
      topStrip.appendChild(thumb);
    });

    // main grid for rest
    const gridWrap = create('div', { class: 'container folder-page-grid-wrap' });
    const grid = create('div', { class: 'folder-page-grid' });
    if (rest.length === 0 && topFiles.length === 0) {
      grid.appendChild(create('div', { class: 'folder-empty' }, 'No photos in this folder'));
    } else {
      rest.forEach(f => {
        const item = create('div', { class: 'folder-file' });
        const img = create('img', { src: basePath + f, alt: f, loading: 'lazy' });
        const meta = create('div', { class: 'file-meta' }, f);
        const actions = create('div', { class: 'file-actions' });
        const open = create('a', { class: 'btn btn-secondary', href: basePath + f, target: '_blank' }, 'View');
        const download = create('a', { class: 'btn btn-cta', href: basePath + f, download: f }, 'Download');
        actions.appendChild(open);
        actions.appendChild(download);
        item.appendChild(img);
        item.appendChild(meta);
        item.appendChild(actions);
        grid.appendChild(item);
      });
    }
    gridWrap.appendChild(grid);

    container.appendChild(topStrip);
    container.appendChild(gridWrap);

    // ensure some nice entrance animation
    requestAnimationFrame(() => {
      topStrip.classList.add('visible');
      grid.classList.add('visible');
    });

    // wire up fallback for top ZIP button similar to root tiles
    topZip.addEventListener('click', async (ev) => {
      ev.preventDefault();

      // Specific path for minnesota.zip in the minnesota folder
      const minnesotaZipPath = '/photos/minnesota/minnesota.zip';

      try {
        // Check if the specific minnesota.zip file exists
        const response = await fetch(minnesotaZipPath, { method: 'HEAD' });

        if (response.ok) {
          // File exists, trigger download
          const a = document.createElement('a');
          a.href = minnesotaZipPath;
          a.download = 'minnesota.zip';
          document.body.appendChild(a);
          a.click();
          a.remove();
          return;
        }
      } catch (error) {
        console.warn('Could not access minnesota.zip:', error);
      }

      // Fallback: try original candidate paths if minnesota.zip is not found
      const candidates = [
        basePath + encodeURIComponent(folderName) + '.zip',
        basePath + encodeURIComponent(folderName) + '.ZIP',
        '/photos/' + encodeURIComponent(folderName) + '.zip',
        '/photos/altfiles/' + encodeURIComponent(folderName) + '.zip'
      ];

      const found = await findAvailableZip(candidates);
      if (found) {
        const a = document.createElement('a');
        a.href = found;
        a.download = topZip.getAttribute('download') || '';
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      }

      // Final fallback to client zip
      createZipFromFolder(basePath, folderName);
    });
  }

  window.photosHelpers.renderFolderPage = renderFolderPage;

  // auto-initialize when on a folder subpage under /photos/<folder>/
  function tryAutoInitFolderPage() {
    const m = window.location.pathname.match(/^\/photos\/([^\/]+)(?:index.html)?$/);
    if (m) {
      const folder = m[1];
      const base = '/photos/' + folder + '/';
      // only run when a gallery root exists or a photos header exists
      const root = document.querySelector('#folder-page-root');
      const header = document.querySelector('.photos-header');
      if (root || header) {
        renderFolderPage(base, '#folder-page-root');
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryAutoInitFolderPage);
  else tryAutoInitFolderPage();

  // wire up root page if present — robust init that works regardless of DOMContentLoaded timing
  function initPhotos() {
    const rootEl = q('#folders-root');
    if (rootEl) renderRoot();

    const dl = q('#download-all-root');
    if (dl) {
      // ensure the button is enabled and clickable
      try { dl.removeAttribute('disabled'); } catch (e) {}
      dl.disabled = false;
      dl.style.pointerEvents = 'auto';

      // attach handler with light UI feedback
      dl.addEventListener('click', async (ev) => {
        // simple guard to avoid double clicks
        if (dl.dataset.busy === '1') return;
        dl.dataset.busy = '1';
        dl.classList.add('busy');
        try {
          await downloadAllVisible();
        } catch (err) {
          console.error('downloadAllVisible error', err);
          // best-effort user feedback
          try { alert('Download failed: ' + (err && err.message ? err.message : 'unknown error')); } catch (e) {}
        } finally {
          dl.dataset.busy = '0';
          dl.classList.remove('busy');
        }
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPhotos);
  else initPhotos();

})();