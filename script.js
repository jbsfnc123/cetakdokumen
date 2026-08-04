(() => {
  'use strict';

  const { PDFDocument, degrees } = window.PDFLib;
  const pdfjsLib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];

  const PAPER = { a4: [595.28, 841.89], letter: [612, 792] };
  const MARGINS = { none: 0, small: 18, medium: 36 };
  const AUTO_PAGE_LONG_SIDE = 842; // pt, sepanjang sisi panjang A4
  const BATCH_PREVIEW_LIMIT = 12;
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|tiff?)$/i;
  const HEIC_EXT = /\.(heic|heif)$/i;
  const THEME_KEY = 'pdf_tools_theme';

  const state = {
    mode: 'page',
    batchFiles: [],
    batchSelectedId: null,
    editor: null,
    selectedPage: null,
    selectedOverlayId: null,
    mergeSources: [],
    mergePages: [],
    mergeImageSize: 'a4',
    imgPages: [],
    imgOpts: { paper: 'auto', orient: 'auto', margin: 'none' },
    dragUid: null,
  };

  const el = {};
  [
    'modeTabs', 'themeBtn', 'themeIconUse', 'helpBtn', 'helpModal', 'helpCloseBtn',
    'toastStack', 'busyOverlay', 'busyText',
    'batchDrop', 'batchEmptyDrop', 'batchPdfInput', 'batchFileList', 'batchCount',
    'batchCurrentTitle', 'batchCurrentMeta', 'batchStatusChip', 'batchPreview',
    'saveBatchSelectedBtn', 'saveBatchAllBtn', 'clearBatchBtn',
    'editorDrop', 'editorEmptyDrop', 'editorPdfInput', 'editorFileInfo', 'editorTitle', 'editorMeta',
    'saveEditorBtn', 'clearEditorBtn', 'selectedPageChip', 'uploadImageLabel', 'imageInput', 'pagesContainer',
    'mergeDrop', 'mergeEmptyDrop', 'mergePdfInput', 'mergePagesGrid', 'mergeSaveBtn', 'mergeResetBtn',
    'mergeInfo', 'mergeStatusChip', 'mergeImageSize',
    'imgDrop', 'imgEmptyDrop', 'imgDocInput', 'imgPagesGrid', 'imgSaveBtn', 'imgResetBtn',
    'imgInfo', 'imgStatusChip', 'imgPaper', 'imgOrient', 'imgMargin',
    'fileItemTemplate', 'pageCardTemplate', 'thumbCardTemplate',
  ].forEach(id => { el[id] = document.getElementById(id); });

  /* ==========================================================================
     Utilitas dasar
     ========================================================================== */
  function uid() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function copyBytes(arrayBuffer) {
    return new Uint8Array(arrayBuffer).slice();
  }

  function toArrayBufferCopy(input) {
    if (input instanceof Uint8Array) return input.slice().buffer;
    return copyBytes(input).buffer;
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function formatBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function tick() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function isTypingTarget(node) {
    if (!node) return false;
    const tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
  }

  /* ==========================================================================
     Toast, busy overlay, modal
     ========================================================================== */
  function toast(message, type = 'info', ms = 4200) {
    const node = document.createElement('div');
    node.className = `toast toast-${type}`;
    node.textContent = message;
    el.toastStack.appendChild(node);
    requestAnimationFrame(() => node.classList.add('show'));
    setTimeout(() => {
      node.classList.remove('show');
      setTimeout(() => node.remove(), 260);
    }, ms);
  }

  let busyCount = 0;
  function setBusy(on, label) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    if (on && label) el.busyText.textContent = label;
    el.busyOverlay.classList.toggle('hidden', busyCount === 0);
  }

  function setBusyLabel(label) {
    if (busyCount > 0) el.busyText.textContent = label;
  }

  async function withBusy(label, fn) {
    setBusy(true, label);
    await tick();
    try {
      return await fn();
    } catch (err) {
      console.error(err);
      toast(err && err.message ? err.message : 'Terjadi kesalahan tak terduga.', 'error', 6000);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function openHelp() { el.helpModal.classList.remove('hidden'); }
  function closeHelp() { el.helpModal.classList.add('hidden'); }

  /* ==========================================================================
     Tema
     ========================================================================== */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    el.themeIconUse.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
    el.themeBtn.title = theme === 'dark' ? 'Ganti ke mode terang' : 'Ganti ke mode gelap';
    try { localStorage.setItem(THEME_KEY, theme); } catch (err) { /* abaikan */ }
  }

  function initTheme() {
    let stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (err) { /* abaikan */ }
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(stored || (prefersDark ? 'dark' : 'light'));
  }

  /* ==========================================================================
     Dropzone & klasifikasi file
     ========================================================================== */
  function dragHasFiles(ev) {
    const types = ev.dataTransfer && ev.dataTransfer.types ? Array.from(ev.dataTransfer.types) : [];
    return types.indexOf('Files') !== -1;
  }

  function makeDropzone(node, onFiles, picker) {
    if (!node) return;
    ['dragenter', 'dragover'].forEach(type => node.addEventListener(type, ev => {
      if (!dragHasFiles(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
      node.classList.add('is-dragging');
    }));
    ['dragleave', 'dragend'].forEach(type => node.addEventListener(type, () => node.classList.remove('is-dragging')));
    node.addEventListener('drop', ev => {
      if (!dragHasFiles(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      node.classList.remove('is-dragging');
      const files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files.length) onFiles(files, ev);
    });
    if (picker) {
      node.addEventListener('click', () => picker.click());
      node.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); picker.click(); }
      });
    }
  }

  function classifyFiles(list) {
    const pdfs = [];
    const images = [];
    const rejected = [];
    Array.from(list).forEach(file => {
      const name = file.name || '';
      if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) pdfs.push(file);
      else if ((file.type && file.type.indexOf('image/') === 0) || IMAGE_EXT.test(name) || HEIC_EXT.test(name)) images.push(file);
      else rejected.push(file);
    });
    if (rejected.length) {
      toast(`${rejected.length} file dilewati karena bukan PDF atau gambar.`, 'warning');
    }
    return { pdfs, images, rejected };
  }

  /* ==========================================================================
     Helper gambar
     ========================================================================== */
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Gagal membaca file gambar.'));
      reader.readAsDataURL(blob);
    });
  }

  function decodeImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('decode-failed'));
      img.src = src;
    });
  }

  const imgElCache = new Map();
  async function getImageEl(dataUrl) {
    if (imgElCache.has(dataUrl)) return imgElCache.get(dataUrl);
    const img = await decodeImage(dataUrl);
    imgElCache.set(dataUrl, img);
    return img;
  }

  function mimeOfDataUrl(dataUrl) {
    const end = dataUrl.indexOf(';');
    return end === -1 ? '' : dataUrl.slice(5, end).toLowerCase();
  }

  // Menghasilkan asset gambar yang siap di-embed pdf-lib: selalu PNG atau JPEG,
  // lengkap dengan dimensi asli untuk menjaga rasio aspek.
  async function loadImageAsset(fileOrBlob, fallbackName) {
    const name = (fileOrBlob && fileOrBlob.name) || fallbackName || 'gambar';
    const dataUrl = await blobToDataUrl(fileOrBlob);
    let img;
    try {
      img = await getImageEl(dataUrl);
    } catch (err) {
      if (HEIC_EXT.test(name)) {
        throw new Error(`"${name}" berformat HEIC/HEIF yang tidak bisa dibaca browser. Ubah dulu ke JPG atau PNG.`);
      }
      throw new Error(`Format gambar "${name}" tidak didukung browser.`);
    }
    if (!img.naturalWidth || !img.naturalHeight) {
      throw new Error(`Gambar "${name}" tidak punya ukuran yang valid.`);
    }

    const mime = mimeOfDataUrl(dataUrl);
    if (mime === 'image/png' || mime === 'image/jpeg') {
      return { name, dataUrl, mime, width: img.naturalWidth, height: img.naturalHeight };
    }
    // pdf-lib hanya mendukung PNG/JPEG, format lain dikonversi lewat canvas.
    return rasterize(img, name, 'image/png');
  }

  function rasterize(img, name, mime, width, height, drawFn) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width || img.naturalWidth));
    canvas.height = Math.max(1, Math.round(height || img.naturalHeight));
    const ctx = canvas.getContext('2d');
    if (drawFn) drawFn(ctx, canvas);
    else ctx.drawImage(img, 0, 0);
    const dataUrl = canvas.toDataURL(mime, 0.92);
    return { name, dataUrl, mime, width: canvas.width, height: canvas.height };
  }

  async function rotateAsset(asset, deg) {
    const img = await getImageEl(asset.dataUrl);
    const swap = Math.abs(deg) % 180 !== 0;
    const w = swap ? img.naturalHeight : img.naturalWidth;
    const h = swap ? img.naturalWidth : img.naturalHeight;
    const mime = asset.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    return rasterize(img, asset.name, mime, w, h, (ctx, canvas) => {
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((deg * Math.PI) / 180);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    });
  }

  function dataUrlToUint8Array(dataUrl) {
    const base64 = dataUrl.split(',')[1] || '';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function embedImageInto(pdfDoc, asset) {
    const bytes = dataUrlToUint8Array(asset.dataUrl);
    return asset.mime.indexOf('png') !== -1 ? pdfDoc.embedPng(bytes) : pdfDoc.embedJpg(bytes);
  }

  function fitContain(iw, ih, boxW, boxH) {
    const scale = Math.min(boxW / iw, boxH / ih);
    return { w: iw * scale, h: ih * scale };
  }

  // Ukuran halaman untuk satu foto, sesuai opsi kertas/orientasi/margin.
  function imagePageSize(asset, paper, orient, marginPt) {
    const margin = marginPt || 0;
    if (paper === 'auto') {
      const scale = AUTO_PAGE_LONG_SIDE / Math.max(asset.width, asset.height);
      return [asset.width * scale + margin * 2, asset.height * scale + margin * 2];
    }
    const [shortSide, longSide] = PAPER[paper] || PAPER.a4;
    let landscape;
    if (orient === 'portrait') landscape = false;
    else if (orient === 'landscape') landscape = true;
    else landscape = asset.width > asset.height;
    return landscape ? [longSide, shortSide] : [shortSide, longSide];
  }

  async function addImagePage(pdfDoc, asset, paper, orient, marginPt) {
    const margin = marginPt || 0;
    const [pw, ph] = imagePageSize(asset, paper, orient, margin);
    const page = pdfDoc.addPage([pw, ph]);
    const embedded = await embedImageInto(pdfDoc, asset);
    const box = fitContain(asset.width, asset.height, Math.max(1, pw - margin * 2), Math.max(1, ph - margin * 2));
    page.drawImage(embedded, {
      x: (pw - box.w) / 2,
      y: (ph - box.h) / 2,
      width: box.w,
      height: box.h,
    });
    return page;
  }

  /* ==========================================================================
     Helper PDF
     ========================================================================== */
  async function loadPdfPreview(bytes) {
    return pdfjsLib.getDocument({
      data: bytes instanceof Uint8Array ? bytes.slice() : copyBytes(bytes),
      disableWorker: true,
      useWorkerFetch: false,
      isEvalSupported: false,
    }).promise;
  }

  async function moveLastPageToFirst(bytes) {
    const srcDoc = await PDFDocument.load(toArrayBufferCopy(bytes));
    const total = srcDoc.getPageCount();
    if (total <= 1) {
      return { pdfDoc: srcDoc, pageOrder: Array.from({ length: total }, (_, i) => i) };
    }
    const pageOrder = [total - 1, ...Array.from({ length: total - 1 }, (_, i) => i)];
    const newDoc = await PDFDocument.create();
    const copiedPages = await newDoc.copyPages(srcDoc, pageOrder);
    copiedPages.forEach(page => newDoc.addPage(page));
    return { pdfDoc: newDoc, pageOrder };
  }

  // Thumbnail halaman PDF di-cache agar grid bisa di-render ulang berkali-kali
  // (setiap kali diurutkan atau dihapus) tanpa merender ulang canvas.
  const thumbCache = new Map();
  async function pdfPageThumb(cacheKey, preview, pageIndex, rotation, scale) {
    const key = `${cacheKey}:${pageIndex}:${rotation || 0}`;
    if (thumbCache.has(key)) return thumbCache.get(key);
    const page = await preview.getPage(pageIndex + 1);
    const viewport = page.getViewport({
      scale: scale || 0.55,
      rotation: (page.rotate + (rotation || 0)) % 360,
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const dataUrl = canvas.toDataURL('image/png');
    thumbCache.set(key, dataUrl);
    return dataUrl;
  }

  function clearThumbCache(prefix) {
    Array.from(thumbCache.keys()).forEach(key => {
      if (key.indexOf(`${prefix}:`) === 0) thumbCache.delete(key);
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ==========================================================================
     Drag-and-drop untuk mengurutkan thumbnail (dipakai mode Gabung & Gambar ke PDF)
     ========================================================================== */
  function clearDropMarkers(container) {
    if (!container) return;
    Array.from(container.querySelectorAll('.thumb-card')).forEach(node => {
      node.classList.remove('drop-before', 'drop-after');
    });
  }

  function enableReorderDrag(card, cardUid, onDrop) {
    card.addEventListener('dragstart', ev => {
      state.dragUid = cardUid;
      card.classList.add('dragging');
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', cardUid);
      }
    });

    card.addEventListener('dragend', () => {
      state.dragUid = null;
      card.classList.remove('dragging');
      clearDropMarkers(card.parentElement);
    });

    card.addEventListener('dragover', ev => {
      if (!state.dragUid || state.dragUid === cardUid) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      const rect = card.getBoundingClientRect();
      const after = ev.clientX > rect.left + rect.width / 2;
      clearDropMarkers(card.parentElement);
      card.classList.toggle('drop-after', after);
      card.classList.toggle('drop-before', !after);
    });

    card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));

    card.addEventListener('drop', ev => {
      ev.preventDefault();
      const dragUid = state.dragUid;
      clearDropMarkers(card.parentElement);
      if (!dragUid || dragUid === cardUid) return;
      const rect = card.getBoundingClientRect();
      onDrop(dragUid, cardUid, ev.clientX > rect.left + rect.width / 2);
    });
  }

  function reorderList(list, dragUid, targetUid, after) {
    const fromIdx = list.findIndex(item => item.uid === dragUid);
    if (fromIdx === -1) return list;
    const [moved] = list.splice(fromIdx, 1);
    const targetIdx = list.findIndex(item => item.uid === targetUid);
    if (targetIdx === -1) list.push(moved);
    else list.splice(after ? targetIdx + 1 : targetIdx, 0, moved);
    return list;
  }

  /* ==========================================================================
     Pergantian mode
     ========================================================================== */
  function setMode(mode) {
    state.mode = mode;
    Array.from(el.modeTabs.querySelectorAll('.tab')).forEach(tab => {
      tab.classList.toggle('active', tab.dataset.mode === mode);
    });
    Array.from(document.querySelectorAll('[data-panel]')).forEach(node => {
      node.classList.toggle('hidden', node.dataset.panel !== mode);
    });
    updateEmptyStates();
  }

  function updateEmptyStates() {
    const toggle = (grid, empty, hasContent) => {
      grid.classList.toggle('hidden', !hasContent);
      empty.classList.toggle('hidden', hasContent);
    };
    toggle(el.batchPreview, el.batchEmptyDrop, state.batchFiles.length > 0);
    toggle(el.pagesContainer, el.editorEmptyDrop, !!state.editor);
    toggle(el.mergePagesGrid, el.mergeEmptyDrop, state.mergePages.length > 0);
    toggle(el.imgPagesGrid, el.imgEmptyDrop, state.imgPages.length > 0);
  }

  /* ==========================================================================
     MODE 1 - Page Remover
     ========================================================================== */
  async function handleBatchFiles(fileList) {
    const { pdfs } = classifyFiles(fileList);
    if (!pdfs.length) {
      toast('Tidak ada file PDF pada pilihan tadi.', 'warning');
      return;
    }
    await withBusy('Memuat PDF…', async () => {
      let added = 0;
      for (let i = 0; i < pdfs.length; i++) {
        const file = pdfs[i];
        setBusyLabel(`Memuat PDF ${i + 1}/${pdfs.length}: ${file.name}`);
        await tick();
        try {
          const bytes = copyBytes(await file.arrayBuffer());
          const preview = await loadPdfPreview(bytes);
          state.batchFiles.push({ id: uid(), file, bytes, preview, pageCount: preview.numPages });
          added++;
        } catch (err) {
          console.error(err);
          toast(`Gagal membaca "${file.name}". File mungkin rusak atau terkunci password.`, 'error', 6000);
        }
      }
      if (!state.batchSelectedId && state.batchFiles[0]) state.batchSelectedId = state.batchFiles[0].id;
      renderBatchFileList();
      await renderBatchPreview();
      updateBatchButtons();
      if (added) toast(`${added} file PDF ditambahkan.`, 'success');
    });
  }

  function getBatchSelected() {
    return state.batchFiles.find(item => item.id === state.batchSelectedId) || null;
  }

  function selectBatchFile(id) {
    state.batchSelectedId = id;
    renderBatchFileList();
    renderBatchPreview();
    updateBatchButtons();
  }

  function removeBatchFile(id) {
    state.batchFiles = state.batchFiles.filter(item => item.id !== id);
    clearThumbCache(id);
    if (state.batchSelectedId === id) {
      state.batchSelectedId = state.batchFiles[0] ? state.batchFiles[0].id : null;
    }
    renderBatchFileList();
    renderBatchPreview();
    updateBatchButtons();
  }

  function renderBatchFileList() {
    el.batchCount.textContent = `${state.batchFiles.length} file`;
    if (!state.batchFiles.length) {
      el.batchFileList.className = 'file-list empty';
      el.batchFileList.textContent = 'Belum ada file PDF.';
      el.batchCurrentTitle.textContent = 'Page Remover';
      el.batchCurrentMeta.textContent = 'Tambahkan PDF untuk mulai. Halaman terakhir akan menjadi halaman pertama.';
      el.batchStatusChip.textContent = 'Menunggu file';
      return;
    }

    el.batchFileList.className = 'file-list';
    el.batchFileList.innerHTML = '';
    state.batchFiles.forEach(item => {
      const node = el.fileItemTemplate.content.firstElementChild.cloneNode(true);
      node.classList.toggle('active', item.id === state.batchSelectedId);
      node.querySelector('.file-name').textContent = item.file.name;
      node.querySelector('.file-size').textContent = formatBytes(item.file.size);
      node.querySelector('.page-count').textContent = `${item.pageCount} hal.`;
      node.addEventListener('click', () => selectBatchFile(item.id));
      node.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectBatchFile(item.id); }
      });
      node.querySelector('.file-remove').addEventListener('click', ev => {
        ev.stopPropagation();
        removeBatchFile(item.id);
      });
      el.batchFileList.appendChild(node);
    });

    const current = getBatchSelected();
    if (current) {
      el.batchCurrentTitle.textContent = current.file.name;
      el.batchCurrentMeta.textContent = current.pageCount > 1
        ? `${current.pageCount} halaman. Preview di bawah sudah menampilkan urutan hasil.`
        : `${current.pageCount} halaman. File 1 halaman disimpan apa adanya.`;
      el.batchStatusChip.textContent = `${state.batchFiles.length} file siap`;
    }
  }

  // Preview urutan hasil: halaman terakhir tampil paling depan.
  async function renderBatchPreview() {
    const current = getBatchSelected();
    updateEmptyStates();
    if (!current) {
      el.batchPreview.innerHTML = '';
      return;
    }
    el.batchPreview.innerHTML = '';
    const total = current.pageCount;
    const fullOrder = total > 1
      ? [total - 1, ...Array.from({ length: total - 1 }, (_, i) => i)]
      : Array.from({ length: total }, (_, i) => i);
    // Preview dibatasi agar PDF ratusan halaman tidak membekukan tampilan.
    const order = fullOrder.slice(0, BATCH_PREVIEW_LIMIT);
    if (fullOrder.length > order.length) {
      el.batchCurrentMeta.textContent = `${total} halaman. Preview menampilkan ${order.length} halaman pertama dari urutan hasil.`;
    }

    for (let position = 0; position < order.length; position++) {
      const sourceIndex = order[position];
      const card = el.thumbCardTemplate.content.firstElementChild.cloneNode(true);
      card.draggable = false;
      card.style.cursor = 'default';
      card.querySelector('.thumb-tools').remove();
      card.querySelector('.thumb-badge').textContent = position === 0 && total > 1 ? 'dari halaman terakhir' : `asal hal. ${sourceIndex + 1}`;
      card.querySelector('.thumb-order').textContent = `#${position + 1}`;
      card.querySelector('.thumb-note').textContent = '';
      el.batchPreview.appendChild(card);
      try {
        card.querySelector('.thumb-img').src = await pdfPageThumb(current.id, current.preview, sourceIndex, 0);
      } catch (err) {
        console.error(err);
      }
    }
  }

  function updateBatchButtons() {
    el.saveBatchAllBtn.disabled = state.batchFiles.length === 0;
    el.saveBatchSelectedBtn.disabled = !getBatchSelected();
  }

  async function exportBatchSelected() {
    const selected = getBatchSelected();
    if (!selected) return;
    await withBusy(`Menyimpan ${selected.file.name}…`, async () => {
      const { pdfDoc } = await moveLastPageToFirst(selected.bytes);
      const bytes = await pdfDoc.save();
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), selected.file.name);
      toast(`"${selected.file.name}" berhasil disimpan.`, 'success');
    });
  }

  async function exportBatchAll() {
    if (!state.batchFiles.length) return;
    await withBusy('Menyiapkan ZIP…', async () => {
      const zip = new JSZip();
      for (let i = 0; i < state.batchFiles.length; i++) {
        const item = state.batchFiles[i];
        setBusyLabel(`Memproses ${i + 1}/${state.batchFiles.length}: ${item.file.name}`);
        await tick();
        const { pdfDoc } = await moveLastPageToFirst(item.bytes);
        zip.file(item.file.name, await pdfDoc.save());
      }
      setBusyLabel('Mengemas ZIP…');
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, 'hasil-pdf.zip');
      toast(`${state.batchFiles.length} file dikemas ke hasil-pdf.zip.`, 'success');
    });
  }

  function resetBatch() {
    state.batchFiles.forEach(item => clearThumbCache(item.id));
    state.batchFiles = [];
    state.batchSelectedId = null;
    el.batchPdfInput.value = '';
    el.batchPreview.innerHTML = '';
    renderBatchFileList();
    updateBatchButtons();
    updateEmptyStates();
  }

  /* ==========================================================================
     MODE 2 - Tempel Gambar
     ========================================================================== */
  function getEditorStorageKey(file) {
    return `pdf_editor_overlays::${file.name}::${file.size}::${file.lastModified}`;
  }

  function persistEditorOverlays() {
    if (!state.editor) return;
    const payload = {
      overlays: state.editor.overlays,
      selectedPage: state.selectedPage,
      selectedOverlayId: state.selectedOverlayId,
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(state.editor.storageKey, JSON.stringify(payload));
      const when = new Date(payload.savedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      el.editorMeta.textContent = `${state.editor.pageCount} halaman • perubahan tersimpan sementara ${when}`;
    } catch (err) {
      console.warn('Gagal simpan sementara:', err);
      el.editorMeta.textContent = `${state.editor.pageCount} halaman • penyimpanan sementara penuh`;
      if (!state.editor.quotaWarned) {
        state.editor.quotaWarned = true;
        toast('Penyimpanan sementara browser penuh, posisi gambar tidak bisa disimpan otomatis. Simpan PDF-nya sekarang agar hasilnya tidak hilang.', 'warning', 8000);
      }
    }
  }

  function restoreEditorOverlays(fileState) {
    try {
      const raw = localStorage.getItem(fileState.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.overlays) && parsed.overlays.length === fileState.pageCount) {
        fileState.overlays = parsed.overlays.map(page => (Array.isArray(page) ? page : []));
      }
      if (Number.isInteger(parsed.selectedPage)) {
        state.selectedPage = clamp(parsed.selectedPage, 0, fileState.pageCount - 1);
      }
      state.selectedOverlayId = parsed.selectedOverlayId || null;
    } catch (err) {
      console.warn('Gagal memuat simpan sementara:', err);
    }
  }

  async function loadEditor(file) {
    await withBusy(`Memuat ${file.name}…`, async () => {
      const bytes = copyBytes(await file.arrayBuffer());
      const preview = await loadPdfPreview(bytes);
      const firstPage = await preview.getPage(1);
      const firstViewport = firstPage.getViewport({ scale: 1 });

      state.editor = {
        id: uid(),
        file,
        bytes,
        preview,
        pageCount: preview.numPages,
        overlays: Array.from({ length: preview.numPages }, () => []),
        baseAspect: firstViewport.width / firstViewport.height,
        storageKey: getEditorStorageKey(file),
        quotaWarned: false,
      };
      state.selectedPage = 0;
      state.selectedOverlayId = null;
      restoreEditorOverlays(state.editor);

      el.editorFileInfo.innerHTML = '';
      el.editorFileInfo.textContent = `${file.name} • ${preview.numPages} halaman • ${formatBytes(file.size)}`;
      el.editorTitle.textContent = file.name;
      el.editorMeta.textContent = `${preview.numPages} halaman siap diedit.`;
      buildEditorPages();
      updateEditorButtons();
      updateEmptyStates();
      toast(`"${file.name}" dimuat, ${preview.numPages} halaman.`, 'success');
    });
  }

  function resetEditor() {
    state.editor = null;
    state.selectedPage = null;
    state.selectedOverlayId = null;
    if (pageObserver) pageObserver.disconnect();
    el.editorPdfInput.value = '';
    el.imageInput.value = '';
    el.editorFileInfo.textContent = 'Belum ada file PDF editor.';
    el.editorTitle.textContent = 'Editor Tempel Gambar';
    el.editorMeta.textContent = 'Pilih PDF editor untuk mulai.';
    el.pagesContainer.innerHTML = '';
    updateEditorButtons();
    updateEmptyStates();
  }

  function updateEditorButtons() {
    const hasEditor = !!state.editor;
    const hasPage = hasEditor && Number.isInteger(state.selectedPage);
    el.saveEditorBtn.disabled = !hasEditor;
    el.uploadImageLabel.classList.toggle('disabled', !hasPage);
    el.imageInput.disabled = !hasPage;
    el.selectedPageChip.textContent = hasPage ? `Halaman aktif: ${state.selectedPage + 1}` : 'Belum ada halaman aktif';
    el.selectedPageChip.className = hasPage ? 'chip' : 'chip neutral';
  }

  let pageObserver = null;

  function buildEditorPages() {
    const file = state.editor;
    if (!file) return;
    el.pagesContainer.innerHTML = '';
    if (pageObserver) pageObserver.disconnect();
    pageObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        pageObserver.unobserve(entry.target);
        renderPageCanvas(entry.target);
      });
    }, { rootMargin: '600px 0px' });

    for (let pageIndex = 0; pageIndex < file.pageCount; pageIndex++) {
      const card = el.pageCardTemplate.content.firstElementChild.cloneNode(true);
      card.dataset.pageIndex = String(pageIndex);
      card.classList.toggle('active', pageIndex === state.selectedPage);
      card.querySelector('.page-title').textContent = `Halaman ${pageIndex + 1}`;
      card.querySelector('.page-footer').textContent = 'Klik untuk menjadikan halaman aktif.';

      // Ukuran sementara agar tata letak tidak melompat sebelum canvas dirender.
      const canvas = card.querySelector('.page-canvas');
      canvas.width = 620;
      canvas.height = Math.round(620 / (file.baseAspect || 0.7071));

      const wrap = card.querySelector('.page-preview-wrap');
      wrap.addEventListener('click', ev => {
        if (ev.target.closest('.overlay-item')) return;
        selectPage(pageIndex);
      });

      card.querySelector('.remove-overlays-btn').addEventListener('click', ev => {
        ev.stopPropagation();
        const count = file.overlays[pageIndex].length;
        if (!count) { toast('Halaman ini belum ada gambarnya.', 'info'); return; }
        file.overlays[pageIndex] = [];
        if (state.selectedPage === pageIndex) state.selectedOverlayId = null;
        renderOverlayLayer(file, pageIndex, card.querySelector('.overlay-layer'));
        persistEditorOverlays();
        toast(`${count} gambar dihapus dari halaman ${pageIndex + 1}.`, 'success');
      });

      makeDropzone(wrap, (files, ev) => handleEditorImageDrop(files, pageIndex, ev));

      el.pagesContainer.appendChild(card);
      renderOverlayLayer(file, pageIndex, card.querySelector('.overlay-layer'));
      pageObserver.observe(card);
    }
  }

  async function renderPageCanvas(card) {
    const file = state.editor;
    if (!file || !card.isConnected) return;
    const pageIndex = Number(card.dataset.pageIndex);
    try {
      const page = await file.preview.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1.2 });
      const canvas = card.querySelector('.page-canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const skeleton = card.querySelector('.page-skeleton');
      if (skeleton) skeleton.remove();
    } catch (err) {
      console.error(err);
      const skeleton = card.querySelector('.page-skeleton');
      if (skeleton) skeleton.textContent = 'Gagal merender halaman ini.';
    }
  }

  function getPageCard(pageIndex) {
    return el.pagesContainer.querySelector(`.page-card[data-page-index="${pageIndex}"]`);
  }

  function selectPage(pageIndex) {
    state.selectedPage = pageIndex;
    state.selectedOverlayId = null;
    refreshPageSelection();
    persistEditorOverlays();
  }

  // Hanya memperbarui kelas, tidak membangun ulang DOM overlay. Membangun ulang
  // di tengah pointerdown akan mencabut node yang sedang diseret.
  function refreshPageSelection() {
    Array.from(el.pagesContainer.querySelectorAll('.page-card')).forEach(node => {
      node.classList.toggle('active', Number(node.dataset.pageIndex) === state.selectedPage);
    });
    Array.from(el.pagesContainer.querySelectorAll('.overlay-item')).forEach(node => {
      node.classList.toggle('selected', node.dataset.overlayId === state.selectedOverlayId);
    });
    updateEditorButtons();
  }

  function renderOverlayLayer(file, pageIndex, layer) {
    if (!layer) return;
    const overlays = file.overlays[pageIndex] || [];
    layer.innerHTML = '';
    overlays.forEach(overlay => {
      const node = document.createElement('div');
      node.className = `overlay-item${state.selectedOverlayId === overlay.id ? ' selected' : ''}`;
      node.dataset.overlayId = overlay.id;
      applyOverlayBox(node, overlay);

      const img = document.createElement('img');
      img.src = overlay.dataUrl;
      img.alt = '';
      node.appendChild(img);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'overlay-remove';
      removeBtn.type = 'button';
      removeBtn.title = 'Hapus gambar';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        removeOverlay(pageIndex, overlay.id);
      });
      node.appendChild(removeBtn);

      const sizeLabel = document.createElement('span');
      sizeLabel.className = 'overlay-size';
      node.appendChild(sizeLabel);

      const handle = document.createElement('div');
      handle.className = 'resize-handle';
      handle.title = 'Tarik untuk mengubah ukuran (tahan Shift untuk bebas rasio)';
      node.appendChild(handle);

      enableOverlayInteractions(node, overlay, file, pageIndex, layer);
      layer.appendChild(node);
    });
  }

  function applyOverlayBox(node, overlay) {
    node.style.left = `${overlay.x * 100}%`;
    node.style.top = `${overlay.y * 100}%`;
    node.style.width = `${overlay.w * 100}%`;
    node.style.height = `${overlay.h * 100}%`;
  }

  function removeOverlay(pageIndex, overlayId) {
    const file = state.editor;
    if (!file) return;
    file.overlays[pageIndex] = file.overlays[pageIndex].filter(item => item.id !== overlayId);
    if (state.selectedOverlayId === overlayId) state.selectedOverlayId = null;
    const card = getPageCard(pageIndex);
    if (card) renderOverlayLayer(file, pageIndex, card.querySelector('.overlay-layer'));
    persistEditorOverlays();
  }

  function enableOverlayInteractions(node, overlay, file, pageIndex, layer) {
    let mode = null;
    let startX = 0;
    let startY = 0;
    let start = null;
    let pageAspect = 1;
    const sizeLabel = node.querySelector('.overlay-size');

    function showSize() {
      const rect = layer.getBoundingClientRect();
      sizeLabel.textContent = `${Math.round(overlay.w * rect.width)} × ${Math.round(overlay.h * rect.height)} px`;
    }

    function onMove(ev) {
      if (!mode) return;
      const rect = layer.getBoundingClientRect();
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;

      if (mode === 'drag') {
        overlay.x = clamp(start.x + dx, 0, 1 - overlay.w);
        overlay.y = clamp(start.y + dy, 0, 1 - overlay.h);
      } else if (ev.shiftKey || !overlay.ratio) {
        // Shift ditahan: bebas, rasio tidak dikunci.
        overlay.w = clamp(start.w + dx, 0.03, 1 - overlay.x);
        overlay.h = clamp(start.h + dy, 0.03, 1 - overlay.y);
      } else {
        let w = clamp(start.w + dx, 0.03, 1 - overlay.x);
        let h = (w * pageAspect) / overlay.ratio;
        if (overlay.y + h > 1) {
          h = 1 - overlay.y;
          w = (h * overlay.ratio) / pageAspect;
        }
        overlay.w = w;
        overlay.h = h;
      }
      applyOverlayBox(node, overlay);
      showSize();
    }

    function onUp() {
      if (!mode) return;
      mode = null;
      node.classList.remove('busy');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      persistEditorOverlays();
    }

    node.addEventListener('pointerdown', ev => {
      if (ev.target.classList.contains('overlay-remove')) return;
      ev.stopPropagation();
      ev.preventDefault();
      const rect = layer.getBoundingClientRect();
      pageAspect = rect.width / rect.height;
      state.selectedPage = pageIndex;
      state.selectedOverlayId = overlay.id;
      refreshPageSelection();

      startX = ev.clientX;
      startY = ev.clientY;
      start = { x: overlay.x, y: overlay.y, w: overlay.w, h: overlay.h };
      mode = ev.target.classList.contains('resize-handle') ? 'resize' : 'drag';
      node.classList.add('busy');
      showSize();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  function findSelectedOverlay() {
    const file = state.editor;
    if (!file || !state.selectedOverlayId) return null;
    for (let pageIndex = 0; pageIndex < file.pageCount; pageIndex++) {
      const overlay = (file.overlays[pageIndex] || []).find(item => item.id === state.selectedOverlayId);
      if (overlay) return { overlay, pageIndex };
    }
    return null;
  }

  async function addImageOverlay(asset, center) {
    const file = state.editor;
    if (!file || !Number.isInteger(state.selectedPage)) {
      toast('Pilih dulu halaman yang mau ditempeli gambar.', 'warning');
      return;
    }
    const pageIndex = state.selectedPage;
    const card = getPageCard(pageIndex);
    const layer = card && card.querySelector('.overlay-layer');
    const rect = layer ? layer.getBoundingClientRect() : { width: 1, height: 1.414 };
    const pageAspect = (rect.width || 1) / (rect.height || 1);
    const ratio = asset.width / asset.height;

    let w = 0.55;
    let h = (w * pageAspect) / ratio;
    if (h > 0.7) {
      h = 0.7;
      w = (h * ratio) / pageAspect;
    }
    w = clamp(w, 0.05, 1);
    h = clamp(h, 0.05, 1);

    const cx = center ? center.x : 0.5;
    const cy = center ? center.y : 0.35;
    const overlay = {
      id: uid(),
      dataUrl: asset.dataUrl,
      mime: asset.mime,
      ratio,
      x: clamp(cx - w / 2, 0, 1 - w),
      y: clamp(cy - h / 2, 0, 1 - h),
      w,
      h,
    };

    file.overlays[pageIndex].push(overlay);
    state.selectedOverlayId = overlay.id;
    if (layer) renderOverlayLayer(file, pageIndex, layer);
    persistEditorOverlays();
  }

  async function addImageFiles(files, center) {
    const { images } = classifyFiles(files);
    if (!images.length) {
      toast('Tidak ada file gambar pada pilihan tadi.', 'warning');
      return;
    }
    await withBusy('Menambahkan gambar…', async () => {
      let added = 0;
      for (const file of images) {
        try {
          const asset = await loadImageAsset(file);
          await addImageOverlay(asset, center);
          added++;
        } catch (err) {
          toast(err.message, 'error', 6000);
        }
      }
      if (added) toast(`${added} gambar ditempel ke halaman ${state.selectedPage + 1}.`, 'success');
    });
  }

  // Foto yang di-drop diletakkan tepat di titik jatuh kursor.
  async function handleEditorImageDrop(files, pageIndex, ev) {
    state.selectedPage = pageIndex;
    refreshPageSelection();
    let center = null;
    const card = getPageCard(pageIndex);
    const layer = card && card.querySelector('.overlay-layer');
    if (layer && ev) {
      const rect = layer.getBoundingClientRect();
      if (rect.width && rect.height) {
        center = {
          x: clamp((ev.clientX - rect.left) / rect.width, 0, 1),
          y: clamp((ev.clientY - rect.top) / rect.height, 0, 1),
        };
      }
    }
    await addImageFiles(files, center);
  }

  async function handlePaste(event) {
    if (state.mode !== 'image' || !state.editor || !Number.isInteger(state.selectedPage)) return;
    if (isTypingTarget(event.target)) return;
    const items = event.clipboardData && event.clipboardData.items ? Array.from(event.clipboardData.items) : [];
    const blobs = items
      .filter(item => item.type && item.type.indexOf('image/') === 0)
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (!blobs.length) return;
    event.preventDefault();
    await withBusy('Menempel dari clipboard…', async () => {
      for (const blob of blobs) {
        try {
          const asset = await loadImageAsset(blob, 'clipboard.png');
          await addImageOverlay(asset, null);
        } catch (err) {
          toast(err.message, 'error', 6000);
        }
      }
      toast(`Gambar ditempel ke halaman ${state.selectedPage + 1}.`, 'success');
    });
  }

  async function exportEditorPdf() {
    const editor = state.editor;
    if (!editor) return;
    await withBusy('Menggabungkan gambar ke PDF…', async () => {
      const pdfDoc = await PDFDocument.load(toArrayBufferCopy(editor.bytes));
      let drawn = 0;
      for (let pageIndex = 0; pageIndex < editor.pageCount; pageIndex++) {
        const overlays = editor.overlays[pageIndex] || [];
        if (!overlays.length) continue;
        const page = pdfDoc.getPage(pageIndex);
        const { width, height } = page.getSize();
        for (const overlay of overlays) {
          const image = await embedImageInto(pdfDoc, { dataUrl: overlay.dataUrl, mime: overlay.mime || mimeOfDataUrl(overlay.dataUrl) });
          const drawW = width * overlay.w;
          const drawH = height * overlay.h;
          page.drawImage(image, {
            x: width * overlay.x,
            y: height - height * overlay.y - drawH,
            width: drawW,
            height: drawH,
          });
          drawn++;
        }
      }
      const bytes = await pdfDoc.save();
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), editor.file.name);
      toast(drawn ? `PDF disimpan dengan ${drawn} gambar tertempel.` : 'PDF disimpan (belum ada gambar tertempel).', 'success');
    });
  }

  /* ==========================================================================
     MODE 3 - Gabung PDF (+ foto)
     ========================================================================== */
  async function handleMergeFiles(fileList) {
    const { pdfs, images } = classifyFiles(fileList);
    if (!pdfs.length && !images.length) {
      toast('Tidak ada PDF atau gambar pada pilihan tadi.', 'warning');
      return;
    }
    await withBusy('Memuat file…', async () => {
      for (const file of pdfs) {
        setBusyLabel(`Memuat PDF: ${file.name}`);
        await tick();
        try {
          const bytes = copyBytes(await file.arrayBuffer());
          const preview = await loadPdfPreview(bytes);
          const srcDoc = await PDFDocument.load(toArrayBufferCopy(bytes));
          const sourceId = uid();
          state.mergeSources.push({
            id: sourceId, kind: 'pdf', file, bytes, srcDoc, preview,
            pageCount: preview.numPages, label: file.name,
          });
          for (let i = 0; i < preview.numPages; i++) {
            state.mergePages.push({ uid: uid(), sourceId, sourcePageIndex: i, rotation: 0 });
          }
        } catch (err) {
          console.error(err);
          toast(`Gagal membaca "${file.name}".`, 'error', 6000);
        }
      }

      for (const file of images) {
        setBusyLabel(`Memuat foto: ${file.name}`);
        await tick();
        try {
          const asset = await loadImageAsset(file);
          const sourceId = uid();
          state.mergeSources.push({ id: sourceId, kind: 'image', file, asset, pageCount: 1, label: file.name });
          state.mergePages.push({ uid: uid(), sourceId, sourcePageIndex: 0, rotation: 0 });
        } catch (err) {
          toast(err.message, 'error', 6000);
        }
      }

      await renderMergeGrid();
      updateMergeButtons();
    });
  }

  function getMergeSource(sourceId) {
    return state.mergeSources.find(source => source.id === sourceId) || null;
  }

  async function renderMergeGrid() {
    updateEmptyStates();
    el.mergePagesGrid.innerHTML = '';
    if (!state.mergePages.length) return;

    for (let order = 0; order < state.mergePages.length; order++) {
      const entry = state.mergePages[order];
      const source = getMergeSource(entry.sourceId);
      if (!source) continue;

      const card = el.thumbCardTemplate.content.firstElementChild.cloneNode(true);
      card.dataset.uid = entry.uid;
      card.querySelector('.thumb-badge').textContent = source.kind === 'image'
        ? source.label
        : `${source.label} · hal. ${entry.sourcePageIndex + 1}`;
      card.querySelector('.thumb-badge').title = source.label;
      card.querySelector('.thumb-order').textContent = `#${order + 1}`;
      card.querySelector('.thumb-note').textContent = source.kind === 'image' ? 'foto' : 'pdf';

      card.querySelector('.thumb-remove').addEventListener('click', ev => {
        ev.stopPropagation();
        state.mergePages = state.mergePages.filter(item => item.uid !== entry.uid);
        renderMergeGrid();
        updateMergeButtons();
      });

      card.querySelector('.thumb-rotate').addEventListener('click', async ev => {
        ev.stopPropagation();
        if (source.kind === 'image') {
          await withBusy('Memutar foto…', async () => {
            source.asset = await rotateAsset(source.asset, 90);
          });
        } else {
          entry.rotation = ((entry.rotation || 0) + 90) % 360;
        }
        await renderMergeGrid();
      });

      enableReorderDrag(card, entry.uid, (dragUid, targetUid, after) => {
        reorderList(state.mergePages, dragUid, targetUid, after);
        renderMergeGrid();
        updateMergeButtons();
      });

      el.mergePagesGrid.appendChild(card);

      try {
        card.querySelector('.thumb-img').src = source.kind === 'image'
          ? source.asset.dataUrl
          : await pdfPageThumb(source.id, source.preview, entry.sourcePageIndex, entry.rotation);
      } catch (err) {
        console.error(err);
      }
    }
  }

  function updateMergeButtons() {
    const totalPages = state.mergePages.length;
    el.mergeSaveBtn.disabled = totalPages === 0;
    if (!state.mergeSources.length) {
      el.mergeInfo.textContent = 'Belum ada file.';
      el.mergeStatusChip.textContent = 'Menunggu file';
      el.mergeStatusChip.className = 'chip neutral';
      return;
    }
    const pdfCount = state.mergeSources.filter(source => source.kind === 'pdf').length;
    const imageCount = state.mergeSources.filter(source => source.kind === 'image').length;
    el.mergeInfo.textContent = `${pdfCount} PDF • ${imageCount} foto • ${totalPages} halaman siap digabung.`;
    el.mergeStatusChip.textContent = `${totalPages} halaman`;
    el.mergeStatusChip.className = 'chip';
  }

  async function exportMergedPdf() {
    if (!state.mergePages.length) return;
    await withBusy('Menggabungkan…', async () => {
      const newDoc = await PDFDocument.create();
      for (let i = 0; i < state.mergePages.length; i++) {
        const entry = state.mergePages[i];
        const source = getMergeSource(entry.sourceId);
        if (!source) continue;
        setBusyLabel(`Menggabungkan halaman ${i + 1}/${state.mergePages.length}`);
        if (i % 8 === 0) await tick();

        if (source.kind === 'pdf') {
          const [copied] = await newDoc.copyPages(source.srcDoc, [entry.sourcePageIndex]);
          if (entry.rotation) {
            copied.setRotation(degrees((copied.getRotation().angle + entry.rotation) % 360));
          }
          newDoc.addPage(copied);
        } else {
          await addImagePage(newDoc, source.asset, state.mergeImageSize, 'auto', 0);
        }
      }
      const bytes = await newDoc.save();
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'gabungan.pdf');
      toast(`${state.mergePages.length} halaman digabung ke gabungan.pdf.`, 'success');
    });
  }

  function resetMerge() {
    state.mergeSources.forEach(source => clearThumbCache(source.id));
    state.mergeSources = [];
    state.mergePages = [];
    state.dragUid = null;
    el.mergePdfInput.value = '';
    el.mergePagesGrid.innerHTML = '';
    updateMergeButtons();
    updateEmptyStates();
  }

  /* ==========================================================================
     MODE 4 - Gambar ke PDF
     ========================================================================== */
  async function handleImageDocFiles(fileList) {
    const { images } = classifyFiles(fileList);
    if (!images.length) {
      toast('Tidak ada file gambar pada pilihan tadi.', 'warning');
      return;
    }
    await withBusy('Memuat foto…', async () => {
      let added = 0;
      for (let i = 0; i < images.length; i++) {
        setBusyLabel(`Memuat foto ${i + 1}/${images.length}: ${images[i].name}`);
        await tick();
        try {
          const asset = await loadImageAsset(images[i]);
          state.imgPages.push({ uid: uid(), asset });
          added++;
        } catch (err) {
          toast(err.message, 'error', 6000);
        }
      }
      renderImgGrid();
      updateImgButtons();
      if (added) toast(`${added} foto ditambahkan.`, 'success');
    });
  }

  function renderImgGrid() {
    updateEmptyStates();
    el.imgPagesGrid.innerHTML = '';
    state.imgPages.forEach((entry, order) => {
      const card = el.thumbCardTemplate.content.firstElementChild.cloneNode(true);
      card.dataset.uid = entry.uid;
      card.querySelector('.thumb-badge').textContent = entry.asset.name;
      card.querySelector('.thumb-badge').title = entry.asset.name;
      card.querySelector('.thumb-order').textContent = `#${order + 1}`;
      card.querySelector('.thumb-note').textContent = `${entry.asset.width}×${entry.asset.height}`;
      card.querySelector('.thumb-img').src = entry.asset.dataUrl;

      card.querySelector('.thumb-remove').addEventListener('click', ev => {
        ev.stopPropagation();
        state.imgPages = state.imgPages.filter(item => item.uid !== entry.uid);
        renderImgGrid();
        updateImgButtons();
      });

      card.querySelector('.thumb-rotate').addEventListener('click', async ev => {
        ev.stopPropagation();
        await withBusy('Memutar foto…', async () => {
          entry.asset = await rotateAsset(entry.asset, 90);
        });
        renderImgGrid();
      });

      enableReorderDrag(card, entry.uid, (dragUid, targetUid, after) => {
        reorderList(state.imgPages, dragUid, targetUid, after);
        renderImgGrid();
      });

      el.imgPagesGrid.appendChild(card);
    });
  }

  function updateImgButtons() {
    const count = state.imgPages.length;
    el.imgSaveBtn.disabled = count === 0;
    el.imgInfo.textContent = count ? `${count} foto siap menjadi ${count} halaman PDF.` : 'Belum ada foto.';
    el.imgStatusChip.textContent = count ? `${count} foto` : 'Menunggu foto';
    el.imgStatusChip.className = count ? 'chip' : 'chip neutral';
  }

  async function exportImagesAsPdf() {
    if (!state.imgPages.length) return;
    await withBusy('Membuat PDF…', async () => {
      const pdfDoc = await PDFDocument.create();
      const margin = MARGINS[state.imgOpts.margin] || 0;
      for (let i = 0; i < state.imgPages.length; i++) {
        setBusyLabel(`Menyusun halaman ${i + 1}/${state.imgPages.length}`);
        if (i % 5 === 0) await tick();
        await addImagePage(pdfDoc, state.imgPages[i].asset, state.imgOpts.paper, state.imgOpts.orient, margin);
      }
      const bytes = await pdfDoc.save();
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'foto-ke-pdf.pdf');
      toast(`${state.imgPages.length} foto disimpan ke foto-ke-pdf.pdf.`, 'success');
    });
  }

  function resetImgDoc() {
    state.imgPages = [];
    el.imgDocInput.value = '';
    el.imgPagesGrid.innerHTML = '';
    updateImgButtons();
    updateEmptyStates();
  }

  /* ==========================================================================
     Keyboard
     ========================================================================== */
  function saveActiveMode() {
    if (state.mode === 'page') return exportBatchSelected();
    if (state.mode === 'image') return exportEditorPdf();
    if (state.mode === 'merge') return exportMergedPdf();
    return exportImagesAsPdf();
  }

  function nudgeSelectedOverlay(dx, dy) {
    const found = findSelectedOverlay();
    if (!found) return false;
    const card = getPageCard(found.pageIndex);
    const layer = card && card.querySelector('.overlay-layer');
    if (!layer) return false;
    const rect = layer.getBoundingClientRect();
    const overlay = found.overlay;
    overlay.x = clamp(overlay.x + dx / rect.width, 0, 1 - overlay.w);
    overlay.y = clamp(overlay.y + dy / rect.height, 0, 1 - overlay.h);
    const node = layer.querySelector(`.overlay-item[data-overlay-id="${overlay.id}"]`);
    if (node) applyOverlayBox(node, overlay);
    persistEditorOverlays();
    return true;
  }

  function handleKeydown(ev) {
    if (ev.key === 'Escape') {
      if (!el.helpModal.classList.contains('hidden')) { closeHelp(); return; }
      if (state.selectedOverlayId) {
        state.selectedOverlayId = null;
        refreshPageSelection();
      }
      return;
    }

    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
      ev.preventDefault();
      saveActiveMode();
      return;
    }

    if (isTypingTarget(ev.target)) return;

    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ['1', '2', '3', '4'].indexOf(ev.key) !== -1) {
      setMode(['page', 'image', 'merge', 'img2pdf'][Number(ev.key) - 1]);
      return;
    }

    if (state.mode !== 'image' || !state.editor) return;

    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      const found = findSelectedOverlay();
      if (found) {
        ev.preventDefault();
        removeOverlay(found.pageIndex, found.overlay.id);
        toast('Gambar dihapus.', 'success', 2200);
      }
      return;
    }

    const step = ev.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[ev.key] && nudgeSelectedOverlay(moves[ev.key][0], moves[ev.key][1])) {
      ev.preventDefault();
    }
  }

  /* ==========================================================================
     Wiring
     ========================================================================== */
  // Cegah browser membuka file ketika drop meleset dari dropzone.
  ['dragover', 'drop'].forEach(type => window.addEventListener(type, ev => {
    if (dragHasFiles(ev)) ev.preventDefault();
  }));

  el.modeTabs.addEventListener('click', ev => {
    const tab = ev.target.closest('.tab');
    if (tab) setMode(tab.dataset.mode);
  });

  el.themeBtn.addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  el.helpBtn.addEventListener('click', openHelp);
  el.helpCloseBtn.addEventListener('click', closeHelp);
  el.helpModal.addEventListener('click', ev => { if (ev.target === el.helpModal) closeHelp(); });

  // Mode 1
  makeDropzone(el.batchDrop, handleBatchFiles, el.batchPdfInput);
  makeDropzone(el.batchEmptyDrop, handleBatchFiles, el.batchPdfInput);
  el.batchPdfInput.addEventListener('change', async ev => {
    if (ev.target.files && ev.target.files.length) await handleBatchFiles(ev.target.files);
    ev.target.value = '';
  });
  el.saveBatchSelectedBtn.addEventListener('click', exportBatchSelected);
  el.saveBatchAllBtn.addEventListener('click', exportBatchAll);
  el.clearBatchBtn.addEventListener('click', resetBatch);

  // Mode 2
  const pickEditorPdf = files => {
    const { pdfs } = classifyFiles(files);
    if (pdfs[0]) loadEditor(pdfs[0]);
    else toast('Pilih satu file PDF untuk editor.', 'warning');
  };
  makeDropzone(el.editorDrop, pickEditorPdf, el.editorPdfInput);
  makeDropzone(el.editorEmptyDrop, pickEditorPdf, el.editorPdfInput);
  el.editorPdfInput.addEventListener('change', async ev => {
    const file = ev.target.files && ev.target.files[0];
    if (file) await loadEditor(file);
    ev.target.value = '';
  });
  el.imageInput.addEventListener('change', async ev => {
    if (ev.target.files && ev.target.files.length) await addImageFiles(ev.target.files, null);
    ev.target.value = '';
  });
  el.saveEditorBtn.addEventListener('click', exportEditorPdf);
  el.clearEditorBtn.addEventListener('click', resetEditor);
  document.addEventListener('paste', handlePaste);

  // Mode 3
  makeDropzone(el.mergeDrop, handleMergeFiles, el.mergePdfInput);
  makeDropzone(el.mergeEmptyDrop, handleMergeFiles, el.mergePdfInput);
  el.mergePdfInput.addEventListener('change', async ev => {
    if (ev.target.files && ev.target.files.length) await handleMergeFiles(ev.target.files);
    ev.target.value = '';
  });
  el.mergeImageSize.addEventListener('change', ev => { state.mergeImageSize = ev.target.value; });
  el.mergeSaveBtn.addEventListener('click', exportMergedPdf);
  el.mergeResetBtn.addEventListener('click', resetMerge);

  // Mode 4
  makeDropzone(el.imgDrop, handleImageDocFiles, el.imgDocInput);
  makeDropzone(el.imgEmptyDrop, handleImageDocFiles, el.imgDocInput);
  el.imgDocInput.addEventListener('change', async ev => {
    if (ev.target.files && ev.target.files.length) await handleImageDocFiles(ev.target.files);
    ev.target.value = '';
  });
  el.imgPaper.addEventListener('change', ev => {
    state.imgOpts.paper = ev.target.value;
    el.imgOrient.disabled = ev.target.value === 'auto';
  });
  el.imgOrient.addEventListener('change', ev => { state.imgOpts.orient = ev.target.value; });
  el.imgMargin.addEventListener('change', ev => { state.imgOpts.margin = ev.target.value; });
  el.imgSaveBtn.addEventListener('click', exportImagesAsPdf);
  el.imgResetBtn.addEventListener('click', resetImgDoc);

  document.addEventListener('keydown', handleKeydown);

  /* ==========================================================================
     Init
     ========================================================================== */
  initTheme();
  setMode('page');
  renderBatchFileList();
  updateBatchButtons();
  resetEditor();
  resetMerge();
  resetImgDoc();
  updateEmptyStates();
})();
