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

  // Metode "Kuat" merender ulang halaman ke JPEG. scale = dpi / 72.
  const COMPRESS_PRESETS = {
    rendah: { scale: 96 / 72, quality: 0.55, label: 'Rendah (96 dpi)' },
    sedang: { scale: 120 / 72, quality: 0.70, label: 'Sedang (120 dpi)' },
    tinggi: { scale: 150 / 72, quality: 0.82, label: 'Tinggi (150 dpi)' },
  };

  const state = {
    mode: 'page',
    // Kumpulan dokumen bersama yang dipakai semua mode.
    docs: [],
    activeDocId: null,
    editor: null,
    selectedPage: null,
    selectedOverlayId: null,
    mergeExtras: [],
    mergePages: [],
    mergeImageSize: 'a4',
    mergeInitialized: false,
    imgPages: [],
    imgOpts: { paper: 'auto', orient: 'auto', margin: 'none' },
    compressOpts: { method: 'lossless', quality: 'sedang' },
    dragUid: null,
  };

  const el = {};
  [
    'modeTabs', 'themeBtn', 'themeIconUse', 'helpBtn', 'helpModal', 'helpCloseBtn',
    'toastStack', 'busyOverlay', 'busyText',
    'docDrop', 'docInput', 'docList', 'docCount', 'docSteps', 'docStepsWrap',
    'docUndoBtn', 'docDownloadAllBtn', 'docClearBtn',
    'batchEmptyDrop', 'batchCurrentTitle', 'batchCurrentMeta', 'batchStatusChip', 'batchPreview',
    'batchApplyBtn', 'batchApplyAllBtn', 'saveBatchSelectedBtn', 'saveBatchAllBtn',
    'editorEmptyDrop', 'editorFileInfo', 'editorTitle', 'editorMeta',
    'editorApplyBtn', 'saveEditorBtn', 'clearEditorBtn', 'selectedPageChip',
    'uploadImageLabel', 'imageInput', 'pagesContainer',
    'mergeDrop', 'mergeEmptyDrop', 'mergePdfInput', 'mergePagesGrid', 'mergeRefreshBtn',
    'mergeApplyBtn', 'mergeSaveBtn', 'mergeResetBtn', 'mergeInfo', 'mergeStatusChip', 'mergeImageSize',
    'imgDrop', 'imgEmptyDrop', 'imgDocInput', 'imgPagesGrid', 'imgApplyBtn', 'imgSaveBtn', 'imgResetBtn',
    'imgInfo', 'imgStatusChip', 'imgPaper', 'imgOrient', 'imgMargin',
    'compressEmptyDrop', 'compressMethod', 'compressQuality', 'compressApplyBtn', 'compressDownloadBtn',
    'compressInfo', 'compressTitle', 'compressMeta', 'compressStatusChip', 'compressResult',
    'compressResultPanel', 'compressWarning',
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

  function withSuffix(name, suffix) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return `${name}${suffix}`;
    return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
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

  // pdf.js menahan buffer halaman yang sudah dirender. Tanpa destroy(), workspace
  // yang menyimpan banyak dokumen sekaligus akan terus menumpuk memori.
  function destroyPreview(preview) {
    if (!preview) return;
    try {
      const result = preview.destroy();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (err) {
      console.warn('Gagal melepas preview:', err);
    }
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

  function pdfBlob(bytes) {
    return new Blob([bytes], { type: 'application/pdf' });
  }

  /* ==========================================================================
     DOKUMEN BERSAMA
     Satu kumpulan dokumen dipakai seluruh mode. Setiap fitur menulis hasilnya
     kembali lewat updateDocBytes(), sehingga bisa langsung dilanjutkan ke fitur
     berikutnya tanpa unduh lalu upload ulang.
     ========================================================================== */
  function getActiveDoc() {
    return state.docs.find(doc => doc.id === state.activeDocId) || null;
  }

  function getDoc(id) {
    return state.docs.find(doc => doc.id === id) || null;
  }

  // Tanda tangan isi dokumen. Dipakai untuk mendeteksi apakah tampilan turunan
  // (editor, preview) sudah basi dan perlu dibangun ulang.
  function docSig(doc) {
    return `${doc.size}:${doc.steps.length}`;
  }

  async function addDoc(name, bytes, stepLabel) {
    const preview = await loadPdfPreview(bytes);
    const doc = {
      id: uid(),
      name,
      bytes,
      preview,
      pageCount: preview.numPages,
      size: bytes.length,
      steps: stepLabel ? [stepLabel] : [],
      prevBytes: null,
      prevSteps: null,
    };
    state.docs.push(doc);
    if (!state.activeDocId) state.activeDocId = doc.id;
    return doc;
  }

  async function updateDocBytes(doc, newBytes, stepLabel) {
    // Preview dimuat lebih dulu: kalau hasilnya rusak, dokumen lama tetap utuh.
    const preview = await loadPdfPreview(newBytes);
    doc.prevBytes = doc.bytes;
    doc.prevSteps = doc.steps.slice();
    destroyPreview(doc.preview);
    doc.preview = preview;
    doc.bytes = newBytes;
    doc.size = newBytes.length;
    doc.pageCount = preview.numPages;
    doc.steps.push(stepLabel);
    clearThumbCache(doc.id);
    renderDocList();
    await refreshModeForDocs();
  }

  async function undoDoc(doc) {
    if (!doc || !doc.prevBytes) return;
    const bytes = doc.prevBytes;
    const steps = doc.prevSteps || [];
    const preview = await loadPdfPreview(bytes);
    destroyPreview(doc.preview);
    doc.preview = preview;
    doc.bytes = bytes;
    doc.size = bytes.length;
    doc.pageCount = preview.numPages;
    doc.steps = steps;
    doc.prevBytes = null;
    doc.prevSteps = null;
    clearThumbCache(doc.id);
    renderDocList();
    await refreshModeForDocs();
  }

  async function removeDoc(id) {
    const doc = getDoc(id);
    if (!doc) return;
    destroyPreview(doc.preview);
    clearThumbCache(doc.id);
    state.docs = state.docs.filter(item => item.id !== id);
    if (state.activeDocId === id) {
      state.activeDocId = state.docs[0] ? state.docs[0].id : null;
    }
    // Halaman merge yang menunjuk dokumen ini ikut dibuang.
    state.mergePages = state.mergePages.filter(entry => entry.kind !== 'doc' || entry.refId !== id);
    renderDocList();
    await refreshModeForDocs();
  }

  async function setActiveDoc(id) {
    if (state.activeDocId === id) return;
    state.activeDocId = id;
    renderDocList();
    await refreshModeForDocs();
  }

  async function clearDocs() {
    state.docs.forEach(doc => {
      destroyPreview(doc.preview);
      clearThumbCache(doc.id);
    });
    state.docs = [];
    state.activeDocId = null;
    state.mergePages = state.mergePages.filter(entry => entry.kind !== 'doc');
    renderDocList();
    await refreshModeForDocs();
  }

  async function handleDocFiles(fileList) {
    const { pdfs, images } = classifyFiles(fileList);
    if (!pdfs.length && !images.length) return;

    if (pdfs.length) {
      await withBusy('Memuat PDF…', async () => {
        let added = 0;
        for (let i = 0; i < pdfs.length; i++) {
          const file = pdfs[i];
          setBusyLabel(`Memuat PDF ${i + 1}/${pdfs.length}: ${file.name}`);
          await tick();
          try {
            const bytes = copyBytes(await file.arrayBuffer());
            await addDoc(file.name, bytes, 'Diunggah');
            added++;
          } catch (err) {
            console.error(err);
            toast(`Gagal membaca "${file.name}". File mungkin rusak atau terkunci password.`, 'error', 6000);
          }
        }
        renderDocList();
        await refreshModeForDocs();
        if (added) toast(`${added} dokumen ditambahkan.`, 'success');
      });
    }

    // Foto tidak bisa jadi dokumen langsung, jadi dialihkan ke mode Gambar ke PDF.
    if (images.length) {
      await handleImageDocFiles(images);
      toast(`${images.length} foto masuk ke mode "Gambar ke PDF". Susun lalu simpan sebagai dokumen baru.`, 'info', 6000);
    }
  }

  function renderDocList() {
    const docs = state.docs;
    el.docCount.textContent = `${docs.length} dokumen`;
    el.docDownloadAllBtn.disabled = docs.length === 0;

    const active = getActiveDoc();
    el.docUndoBtn.disabled = !active || !active.prevBytes;

    if (active && active.steps.length) {
      el.docStepsWrap.classList.remove('hidden');
      el.docSteps.textContent = active.steps.join(' → ');
    } else {
      el.docStepsWrap.classList.add('hidden');
      el.docSteps.textContent = '';
    }

    if (!docs.length) {
      el.docList.className = 'file-list empty';
      el.docList.textContent = 'Belum ada dokumen.';
      return;
    }

    el.docList.className = 'file-list';
    el.docList.innerHTML = '';
    docs.forEach(doc => {
      const node = el.fileItemTemplate.content.firstElementChild.cloneNode(true);
      node.classList.toggle('active', doc.id === state.activeDocId);
      node.querySelector('.file-name').textContent = doc.name;
      node.querySelector('.file-name').title = doc.name;
      node.querySelector('.file-size').textContent = formatBytes(doc.size);
      node.querySelector('.page-count').textContent = `${doc.pageCount} hal.`;

      node.addEventListener('click', () => setActiveDoc(doc.id));
      node.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setActiveDoc(doc.id); }
      });
      node.querySelector('.file-download').addEventListener('click', ev => {
        ev.stopPropagation();
        downloadBlob(pdfBlob(doc.bytes), doc.name);
        toast(`"${doc.name}" diunduh.`, 'success');
      });
      node.querySelector('.file-remove').addEventListener('click', ev => {
        ev.stopPropagation();
        removeDoc(doc.id);
      });
      el.docList.appendChild(node);
    });
  }

  async function downloadAllDocsZip() {
    if (!state.docs.length) return;
    await withBusy('Menyiapkan ZIP…', async () => {
      const zip = new JSZip();
      const used = new Map();
      state.docs.forEach(doc => {
        // Nama dokumen bisa kembar (mis. dua hasil gabungan), jadi dibuat unik.
        const count = used.get(doc.name) || 0;
        used.set(doc.name, count + 1);
        zip.file(count ? withSuffix(doc.name, `-${count + 1}`) : doc.name, doc.bytes);
      });
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, 'dokumen-pdf.zip');
      toast(`${state.docs.length} dokumen dikemas ke dokumen-pdf.zip.`, 'success');
    });
  }

  // Membangun ulang tampilan mode aktif setelah kumpulan dokumen berubah.
  async function refreshModeForDocs() {
    updateEmptyStates();
    updateDocDependentButtons();
    if (state.mode === 'page') await renderBatchPreview();
    else if (state.mode === 'image') await syncEditorWithActiveDoc();
    else if (state.mode === 'compress') renderCompressPanel();
    // Grid merge ikut dirender ulang: thumbnail dokumen yang baru diproses sudah
    // dibuang dari cache, jadi kartu lama akan menampilkan gambar yang basi.
    else if (state.mode === 'merge') { await renderMergeGrid(); updateMergeButtons(); }
  }

  function updateDocDependentButtons() {
    const active = getActiveDoc();
    const hasDocs = state.docs.length > 0;

    el.batchApplyBtn.disabled = !active;
    el.batchApplyAllBtn.disabled = !hasDocs;
    el.saveBatchSelectedBtn.disabled = !active;
    el.saveBatchAllBtn.disabled = !hasDocs;

    el.compressApplyBtn.disabled = !active;
    el.compressDownloadBtn.disabled = !active;
  }

  /* ==========================================================================
     Pergantian mode
     ========================================================================== */
  async function setMode(mode) {
    state.mode = mode;
    Array.from(el.modeTabs.querySelectorAll('.tab')).forEach(tab => {
      tab.classList.toggle('active', tab.dataset.mode === mode);
    });
    Array.from(document.querySelectorAll('[data-panel]')).forEach(node => {
      node.classList.toggle('hidden', node.dataset.panel !== mode);
    });
    // Mode Gabung mengambil halaman dari semua dokumen saat pertama dibuka.
    if (mode === 'merge' && !state.mergeInitialized && state.docs.length) {
      state.mergeInitialized = true;
      await rebuildMergeFromDocs();
    }
    await refreshModeForDocs();
  }

  function updateEmptyStates() {
    const toggle = (grid, empty, hasContent) => {
      if (!grid || !empty) return;
      grid.classList.toggle('hidden', !hasContent);
      empty.classList.toggle('hidden', hasContent);
    };
    const hasActive = !!getActiveDoc();
    toggle(el.batchPreview, el.batchEmptyDrop, hasActive);
    toggle(el.pagesContainer, el.editorEmptyDrop, hasActive);
    toggle(el.compressResultPanel, el.compressEmptyDrop, hasActive);
    toggle(el.mergePagesGrid, el.mergeEmptyDrop, state.mergePages.length > 0);
    toggle(el.imgPagesGrid, el.imgEmptyDrop, state.imgPages.length > 0);
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
     MODE 1 - Page Remover
     ========================================================================== */
  // Preview urutan hasil: halaman terakhir tampil paling depan.
  async function renderBatchPreview() {
    const doc = getActiveDoc();
    updateEmptyStates();
    if (!doc) {
      el.batchPreview.innerHTML = '';
      el.batchCurrentTitle.textContent = 'Page Remover';
      el.batchCurrentMeta.textContent = 'Tambahkan dokumen untuk mulai. Halaman terakhir akan menjadi halaman pertama.';
      el.batchStatusChip.textContent = 'Menunggu dokumen';
      el.batchStatusChip.className = 'chip neutral';
      return;
    }

    el.batchCurrentTitle.textContent = doc.name;
    el.batchStatusChip.textContent = `${state.docs.length} dokumen`;
    el.batchStatusChip.className = 'chip';
    el.batchPreview.innerHTML = '';

    const total = doc.pageCount;
    const fullOrder = total > 1
      ? [total - 1, ...Array.from({ length: total - 1 }, (_, i) => i)]
      : Array.from({ length: total }, (_, i) => i);
    // Preview dibatasi agar PDF ratusan halaman tidak membekukan tampilan.
    const order = fullOrder.slice(0, BATCH_PREVIEW_LIMIT);
    el.batchCurrentMeta.textContent = fullOrder.length > order.length
      ? `${total} halaman. Preview menampilkan ${order.length} halaman pertama dari urutan hasil.`
      : (total > 1
        ? `${total} halaman. Preview di bawah sudah menampilkan urutan hasil.`
        : `${total} halaman. Dokumen 1 halaman tidak berubah.`);

    const renderToken = doc.id + docSig(doc);
    el.batchPreview.dataset.token = renderToken;

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
        const src = await pdfPageThumb(doc.id, doc.preview, sourceIndex, 0);
        // Dokumen bisa berganti selagi thumbnail dirender.
        if (el.batchPreview.dataset.token !== renderToken) return;
        card.querySelector('.thumb-img').src = src;
      } catch (err) {
        console.error(err);
      }
    }
  }

  async function applyBatchToDoc(doc) {
    const { pdfDoc } = await moveLastPageToFirst(doc.bytes);
    const bytes = await pdfDoc.save();
    await updateDocBytes(doc, bytes, 'Page Remover');
  }

  async function applyBatchActive() {
    const doc = getActiveDoc();
    if (!doc) return;
    if (doc.pageCount <= 1) {
      toast('Dokumen hanya punya 1 halaman, tidak ada yang perlu dipindah.', 'info');
      return;
    }
    await withBusy(`Memproses ${doc.name}…`, async () => {
      await applyBatchToDoc(doc);
      toast(`Halaman terakhir "${doc.name}" dipindah ke depan.`, 'success');
    });
  }

  async function applyBatchAll() {
    if (!state.docs.length) return;
    await withBusy('Memproses semua dokumen…', async () => {
      let done = 0;
      for (let i = 0; i < state.docs.length; i++) {
        const doc = state.docs[i];
        setBusyLabel(`Memproses ${i + 1}/${state.docs.length}: ${doc.name}`);
        await tick();
        if (doc.pageCount <= 1) continue;
        await applyBatchToDoc(doc);
        done++;
      }
      toast(done ? `${done} dokumen diproses.` : 'Tidak ada dokumen yang punya lebih dari 1 halaman.', done ? 'success' : 'info');
    });
  }

  async function exportBatchSelected() {
    const doc = getActiveDoc();
    if (!doc) return;
    await withBusy(`Menyimpan ${doc.name}…`, async () => {
      const { pdfDoc } = await moveLastPageToFirst(doc.bytes);
      const bytes = await pdfDoc.save();
      downloadBlob(pdfBlob(bytes), doc.name);
      toast(`"${doc.name}" berhasil diunduh.`, 'success');
    });
  }

  async function exportBatchAll() {
    if (!state.docs.length) return;
    await withBusy('Menyiapkan ZIP…', async () => {
      const zip = new JSZip();
      const used = new Map();
      for (let i = 0; i < state.docs.length; i++) {
        const doc = state.docs[i];
        setBusyLabel(`Memproses ${i + 1}/${state.docs.length}: ${doc.name}`);
        await tick();
        const { pdfDoc } = await moveLastPageToFirst(doc.bytes);
        const count = used.get(doc.name) || 0;
        used.set(doc.name, count + 1);
        zip.file(count ? withSuffix(doc.name, `-${count + 1}`) : doc.name, await pdfDoc.save());
      }
      setBusyLabel('Mengemas ZIP…');
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, 'hasil-pdf.zip');
      toast(`${state.docs.length} dokumen dikemas ke hasil-pdf.zip.`, 'success');
    });
  }

  /* ==========================================================================
     MODE 2 - Tempel Gambar
     ========================================================================== */
  // Kunci dibuat dari isi dokumen, bukan metadata file. Setelah dokumen diproses
  // fitur lain, kuncinya berubah sehingga overlay lama tidak tertempel dua kali.
  function getEditorStorageKey(doc) {
    return `pdf_editor_overlays::${doc.name}::${doc.size}::${doc.steps.length}`;
  }

  function persistEditorOverlays() {
    const editor = state.editor;
    if (!editor) return;
    const payload = {
      overlays: editor.overlays,
      selectedPage: state.selectedPage,
      selectedOverlayId: state.selectedOverlayId,
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(editor.storageKey, JSON.stringify(payload));
      const when = new Date(payload.savedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      el.editorMeta.textContent = `${editor.pageCount} halaman • perubahan tersimpan sementara ${when}`;
    } catch (err) {
      console.warn('Gagal simpan sementara:', err);
      el.editorMeta.textContent = `${editor.pageCount} halaman • penyimpanan sementara penuh`;
      if (!editor.quotaWarned) {
        editor.quotaWarned = true;
        toast('Penyimpanan sementara browser penuh, posisi gambar tidak bisa disimpan otomatis. Terapkan atau unduh PDF-nya sekarang agar hasilnya tidak hilang.', 'warning', 8000);
      }
    }
  }

  function restoreEditorOverlays(editor) {
    try {
      const raw = localStorage.getItem(editor.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.overlays) && parsed.overlays.length === editor.pageCount) {
        editor.overlays = parsed.overlays.map(page => (Array.isArray(page) ? page : []));
      }
      if (Number.isInteger(parsed.selectedPage)) {
        state.selectedPage = clamp(parsed.selectedPage, 0, editor.pageCount - 1);
      }
      state.selectedOverlayId = parsed.selectedOverlayId || null;
    } catch (err) {
      console.warn('Gagal memuat simpan sementara:', err);
    }
  }

  function countOverlays(editor) {
    return editor ? editor.overlays.reduce((total, list) => total + list.length, 0) : 0;
  }

  // Editor selalu mengikuti dokumen aktif. Dibangun ulang hanya bila dokumennya
  // berganti atau isinya berubah, supaya overlay yang sedang disusun tidak hilang
  // ketika berpindah mode bolak-balik.
  async function syncEditorWithActiveDoc() {
    const doc = getActiveDoc();
    if (!doc) {
      state.editor = null;
      state.selectedPage = null;
      state.selectedOverlayId = null;
      if (pageObserver) pageObserver.disconnect();
      el.pagesContainer.innerHTML = '';
      el.editorFileInfo.textContent = 'Belum ada dokumen aktif.';
      el.editorTitle.textContent = 'Editor Tempel Gambar';
      el.editorMeta.textContent = 'Pilih dokumen di panel Dokumen untuk mulai.';
      updateEditorButtons();
      updateEmptyStates();
      return;
    }

    const sig = docSig(doc);
    if (state.editor && state.editor.docId === doc.id && state.editor.sig === sig) {
      updateEditorButtons();
      return;
    }

    await withBusy(`Menyiapkan ${doc.name}…`, async () => {
      const firstPage = await doc.preview.getPage(1);
      const firstViewport = firstPage.getViewport({ scale: 1 });

      state.editor = {
        docId: doc.id,
        sig,
        pageCount: doc.pageCount,
        overlays: Array.from({ length: doc.pageCount }, () => []),
        baseAspect: firstViewport.width / firstViewport.height,
        storageKey: getEditorStorageKey(doc),
        quotaWarned: false,
      };
      state.selectedPage = 0;
      state.selectedOverlayId = null;
      restoreEditorOverlays(state.editor);

      el.editorFileInfo.textContent = `${doc.name} • ${doc.pageCount} halaman • ${formatBytes(doc.size)}`;
      el.editorTitle.textContent = doc.name;
      el.editorMeta.textContent = `${doc.pageCount} halaman siap diedit.`;
      buildEditorPages();
      updateEditorButtons();
      updateEmptyStates();
    });
  }

  function clearEditorOverlays() {
    const editor = state.editor;
    if (!editor) return;
    const count = countOverlays(editor);
    if (!count) {
      toast('Belum ada gambar yang ditempel.', 'info');
      return;
    }
    editor.overlays = Array.from({ length: editor.pageCount }, () => []);
    state.selectedOverlayId = null;
    Array.from(el.pagesContainer.querySelectorAll('.page-card')).forEach(node => {
      renderOverlayLayer(editor, Number(node.dataset.pageIndex), node.querySelector('.overlay-layer'));
    });
    persistEditorOverlays();
    updateEditorButtons();
    toast(`${count} gambar dihapus.`, 'success');
  }

  function updateEditorButtons() {
    const editor = state.editor;
    const hasEditor = !!editor;
    const hasPage = hasEditor && Number.isInteger(state.selectedPage);
    const hasOverlays = countOverlays(editor) > 0;
    el.editorApplyBtn.disabled = !hasOverlays;
    el.saveEditorBtn.disabled = !hasEditor;
    el.clearEditorBtn.disabled = !hasOverlays;
    el.uploadImageLabel.classList.toggle('disabled', !hasPage);
    el.imageInput.disabled = !hasPage;
    el.selectedPageChip.textContent = hasPage ? `Halaman aktif: ${state.selectedPage + 1}` : 'Belum ada halaman aktif';
    el.selectedPageChip.className = hasPage ? 'chip' : 'chip neutral';
  }

  let pageObserver = null;

  function buildEditorPages() {
    const editor = state.editor;
    if (!editor) return;
    el.pagesContainer.innerHTML = '';
    if (pageObserver) pageObserver.disconnect();
    pageObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        pageObserver.unobserve(entry.target);
        renderPageCanvas(entry.target);
      });
    }, { rootMargin: '600px 0px' });

    for (let pageIndex = 0; pageIndex < editor.pageCount; pageIndex++) {
      const card = el.pageCardTemplate.content.firstElementChild.cloneNode(true);
      card.dataset.pageIndex = String(pageIndex);
      card.classList.toggle('active', pageIndex === state.selectedPage);
      card.querySelector('.page-title').textContent = `Halaman ${pageIndex + 1}`;
      card.querySelector('.page-footer').textContent = 'Klik untuk menjadikan halaman aktif.';

      // Ukuran sementara agar tata letak tidak melompat sebelum canvas dirender.
      const canvas = card.querySelector('.page-canvas');
      canvas.width = 620;
      canvas.height = Math.round(620 / (editor.baseAspect || 0.7071));

      const wrap = card.querySelector('.page-preview-wrap');
      wrap.addEventListener('click', ev => {
        if (ev.target.closest('.overlay-item')) return;
        selectPage(pageIndex);
      });

      card.querySelector('.remove-overlays-btn').addEventListener('click', ev => {
        ev.stopPropagation();
        const count = editor.overlays[pageIndex].length;
        if (!count) { toast('Halaman ini belum ada gambarnya.', 'info'); return; }
        editor.overlays[pageIndex] = [];
        if (state.selectedPage === pageIndex) state.selectedOverlayId = null;
        renderOverlayLayer(editor, pageIndex, card.querySelector('.overlay-layer'));
        persistEditorOverlays();
        updateEditorButtons();
        toast(`${count} gambar dihapus dari halaman ${pageIndex + 1}.`, 'success');
      });

      makeDropzone(wrap, (files, ev) => handleEditorImageDrop(files, pageIndex, ev));

      el.pagesContainer.appendChild(card);
      renderOverlayLayer(editor, pageIndex, card.querySelector('.overlay-layer'));
      pageObserver.observe(card);
    }
  }

  async function renderPageCanvas(card) {
    const editor = state.editor;
    const doc = getActiveDoc();
    if (!editor || !doc || !card.isConnected) return;
    const pageIndex = Number(card.dataset.pageIndex);
    try {
      const page = await doc.preview.getPage(pageIndex + 1);
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

  function renderOverlayLayer(editor, pageIndex, layer) {
    if (!layer) return;
    const overlays = editor.overlays[pageIndex] || [];
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

      enableOverlayInteractions(node, overlay, editor, pageIndex, layer);
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
    const editor = state.editor;
    if (!editor) return;
    editor.overlays[pageIndex] = editor.overlays[pageIndex].filter(item => item.id !== overlayId);
    if (state.selectedOverlayId === overlayId) state.selectedOverlayId = null;
    const card = getPageCard(pageIndex);
    if (card) renderOverlayLayer(editor, pageIndex, card.querySelector('.overlay-layer'));
    persistEditorOverlays();
    updateEditorButtons();
  }

  function enableOverlayInteractions(node, overlay, editor, pageIndex, layer) {
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
    const editor = state.editor;
    if (!editor || !state.selectedOverlayId) return null;
    for (let pageIndex = 0; pageIndex < editor.pageCount; pageIndex++) {
      const overlay = (editor.overlays[pageIndex] || []).find(item => item.id === state.selectedOverlayId);
      if (overlay) return { overlay, pageIndex };
    }
    return null;
  }

  async function addImageOverlay(asset, center) {
    const editor = state.editor;
    if (!editor || !Number.isInteger(state.selectedPage)) {
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

    editor.overlays[pageIndex].push(overlay);
    state.selectedOverlayId = overlay.id;
    if (layer) renderOverlayLayer(editor, pageIndex, layer);
    persistEditorOverlays();
    updateEditorButtons();
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
    // PDF yang jatuh di area halaman tetap masuk sebagai dokumen baru.
    const hasPdf = Array.from(files).some(file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
    if (hasPdf) { await handleDocFiles(files); return; }
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

  // Menempelkan seluruh overlay ke byte PDF dokumen aktif.
  async function buildEditorBytes(doc) {
    const editor = state.editor;
    const pdfDoc = await PDFDocument.load(toArrayBufferCopy(doc.bytes));
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
    return { bytes: await pdfDoc.save(), drawn };
  }

  async function applyEditorToDoc() {
    const doc = getActiveDoc();
    if (!doc || !state.editor) return;
    if (!countOverlays(state.editor)) {
      toast('Belum ada gambar yang ditempel.', 'info');
      return;
    }
    await withBusy('Menempelkan gambar ke dokumen…', async () => {
      const { bytes, drawn } = await buildEditorBytes(doc);
      // Buang simpanan sementara milik versi lama supaya tidak tertempel ulang.
      try { localStorage.removeItem(state.editor.storageKey); } catch (err) { /* abaikan */ }
      state.editor = null;
      await updateDocBytes(doc, bytes, 'Tempel Gambar');
      toast(`${drawn} gambar ditempel ke "${doc.name}". Lanjutkan ke fitur lain kalau perlu.`, 'success', 5200);
    });
  }

  async function exportEditorPdf() {
    const doc = getActiveDoc();
    if (!doc || !state.editor) return;
    await withBusy('Menggabungkan gambar ke PDF…', async () => {
      const { bytes, drawn } = await buildEditorBytes(doc);
      downloadBlob(pdfBlob(bytes), doc.name);
      toast(drawn ? `PDF diunduh dengan ${drawn} gambar tertempel.` : 'PDF diunduh (belum ada gambar tertempel).', 'success');
    });
  }

  /* ==========================================================================
     MODE 3 - Gabung PDF (+ foto)
     ========================================================================== */
  function getMergeRef(entry) {
    return entry.kind === 'doc' ? getDoc(entry.refId) : state.mergeExtras.find(item => item.id === entry.refId);
  }

  async function rebuildMergeFromDocs() {
    state.mergePages = [];
    state.docs.forEach(doc => {
      for (let i = 0; i < doc.pageCount; i++) {
        state.mergePages.push({ uid: uid(), kind: 'doc', refId: doc.id, sourcePageIndex: i, rotation: 0 });
      }
    });
    state.mergeExtras.forEach(extra => {
      state.mergePages.push({ uid: uid(), kind: 'image', refId: extra.id, sourcePageIndex: 0, rotation: 0 });
    });
    await renderMergeGrid();
    updateMergeButtons();
  }

  async function handleMergeFiles(fileList) {
    const { pdfs, images } = classifyFiles(fileList);
    if (!pdfs.length && !images.length) {
      toast('Tidak ada PDF atau gambar pada pilihan tadi.', 'warning');
      return;
    }

    // PDF baru masuk ke kumpulan dokumen bersama, lalu halamannya ditambahkan.
    if (pdfs.length) {
      await withBusy('Memuat PDF…', async () => {
        for (const file of pdfs) {
          setBusyLabel(`Memuat PDF: ${file.name}`);
          await tick();
          try {
            const bytes = copyBytes(await file.arrayBuffer());
            const doc = await addDoc(file.name, bytes, 'Diunggah');
            for (let i = 0; i < doc.pageCount; i++) {
              state.mergePages.push({ uid: uid(), kind: 'doc', refId: doc.id, sourcePageIndex: i, rotation: 0 });
            }
          } catch (err) {
            console.error(err);
            toast(`Gagal membaca "${file.name}".`, 'error', 6000);
          }
        }
        renderDocList();
      });
    }

    if (images.length) {
      await withBusy('Memuat foto…', async () => {
        for (const file of images) {
          setBusyLabel(`Memuat foto: ${file.name}`);
          await tick();
          try {
            const asset = await loadImageAsset(file);
            const extraId = uid();
            state.mergeExtras.push({ id: extraId, asset, label: asset.name });
            state.mergePages.push({ uid: uid(), kind: 'image', refId: extraId, sourcePageIndex: 0, rotation: 0 });
          } catch (err) {
            toast(err.message, 'error', 6000);
          }
        }
      });
    }

    state.mergeInitialized = true;
    await renderMergeGrid();
    updateMergeButtons();
  }

  async function renderMergeGrid() {
    updateEmptyStates();
    el.mergePagesGrid.innerHTML = '';
    if (!state.mergePages.length) return;

    const token = uid();
    el.mergePagesGrid.dataset.token = token;

    for (let order = 0; order < state.mergePages.length; order++) {
      const entry = state.mergePages[order];
      const ref = getMergeRef(entry);
      if (!ref) continue;
      const isImage = entry.kind === 'image';
      const label = isImage ? ref.label : ref.name;

      const card = el.thumbCardTemplate.content.firstElementChild.cloneNode(true);
      card.dataset.uid = entry.uid;
      card.querySelector('.thumb-badge').textContent = isImage ? label : `${label} · hal. ${entry.sourcePageIndex + 1}`;
      card.querySelector('.thumb-badge').title = label;
      card.querySelector('.thumb-order').textContent = `#${order + 1}`;
      card.querySelector('.thumb-note').textContent = isImage ? 'foto' : 'pdf';

      card.querySelector('.thumb-remove').addEventListener('click', ev => {
        ev.stopPropagation();
        state.mergePages = state.mergePages.filter(item => item.uid !== entry.uid);
        renderMergeGrid();
        updateMergeButtons();
      });

      card.querySelector('.thumb-rotate').addEventListener('click', async ev => {
        ev.stopPropagation();
        if (isImage) {
          await withBusy('Memutar foto…', async () => {
            ref.asset = await rotateAsset(ref.asset, 90);
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
        const src = isImage
          ? ref.asset.dataUrl
          : await pdfPageThumb(ref.id, ref.preview, entry.sourcePageIndex, entry.rotation);
        if (el.mergePagesGrid.dataset.token !== token) return;
        card.querySelector('.thumb-img').src = src;
      } catch (err) {
        console.error(err);
      }
    }
  }

  function updateMergeButtons() {
    const totalPages = state.mergePages.length;
    el.mergeSaveBtn.disabled = totalPages === 0;
    el.mergeApplyBtn.disabled = totalPages === 0;
    el.mergeRefreshBtn.disabled = state.docs.length === 0 && state.mergeExtras.length === 0;

    if (!totalPages) {
      el.mergeInfo.textContent = 'Belum ada halaman.';
      el.mergeStatusChip.textContent = 'Menunggu file';
      el.mergeStatusChip.className = 'chip neutral';
      return;
    }
    const docPages = state.mergePages.filter(entry => entry.kind === 'doc').length;
    const imagePages = totalPages - docPages;
    el.mergeInfo.textContent = `${docPages} halaman PDF • ${imagePages} foto • total ${totalPages} halaman.`;
    el.mergeStatusChip.textContent = `${totalPages} halaman`;
    el.mergeStatusChip.className = 'chip';
  }

  async function buildMergedBytes() {
    const newDoc = await PDFDocument.create();
    // Tiap dokumen sumber cukup di-load sekali, meski halamannya terpencar.
    const loaded = new Map();
    for (let i = 0; i < state.mergePages.length; i++) {
      const entry = state.mergePages[i];
      const ref = getMergeRef(entry);
      if (!ref) continue;
      setBusyLabel(`Menggabungkan halaman ${i + 1}/${state.mergePages.length}`);
      if (i % 8 === 0) await tick();

      if (entry.kind === 'doc') {
        if (!loaded.has(ref.id)) {
          loaded.set(ref.id, await PDFDocument.load(toArrayBufferCopy(ref.bytes)));
        }
        const [copied] = await newDoc.copyPages(loaded.get(ref.id), [entry.sourcePageIndex]);
        if (entry.rotation) {
          copied.setRotation(degrees((copied.getRotation().angle + entry.rotation) % 360));
        }
        newDoc.addPage(copied);
      } else {
        await addImagePage(newDoc, ref.asset, state.mergeImageSize, 'auto', 0);
      }
    }
    return newDoc.save();
  }

  async function applyMergeAsDoc() {
    if (!state.mergePages.length) return;
    await withBusy('Menggabungkan…', async () => {
      const bytes = await buildMergedBytes();
      const doc = await addDoc('gabungan.pdf', bytes, 'Gabung PDF');
      state.activeDocId = doc.id;
      renderDocList();
      await refreshModeForDocs();
      toast(`Dokumen baru "gabungan.pdf" dibuat (${doc.pageCount} halaman) dan dijadikan dokumen aktif.`, 'success', 5200);
    });
  }

  async function exportMergedPdf() {
    if (!state.mergePages.length) return;
    await withBusy('Menggabungkan…', async () => {
      const bytes = await buildMergedBytes();
      downloadBlob(pdfBlob(bytes), 'gabungan.pdf');
      toast(`${state.mergePages.length} halaman digabung ke gabungan.pdf.`, 'success');
    });
  }

  async function resetMerge() {
    state.mergeExtras = [];
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
    el.imgApplyBtn.disabled = count === 0;
    el.imgInfo.textContent = count ? `${count} foto siap menjadi ${count} halaman PDF.` : 'Belum ada foto.';
    el.imgStatusChip.textContent = count ? `${count} foto` : 'Menunggu foto';
    el.imgStatusChip.className = count ? 'chip' : 'chip neutral';
  }

  async function buildImagesPdfBytes() {
    const pdfDoc = await PDFDocument.create();
    const margin = MARGINS[state.imgOpts.margin] || 0;
    for (let i = 0; i < state.imgPages.length; i++) {
      setBusyLabel(`Menyusun halaman ${i + 1}/${state.imgPages.length}`);
      if (i % 5 === 0) await tick();
      await addImagePage(pdfDoc, state.imgPages[i].asset, state.imgOpts.paper, state.imgOpts.orient, margin);
    }
    return pdfDoc.save();
  }

  async function applyImagesAsDoc() {
    if (!state.imgPages.length) return;
    await withBusy('Membuat PDF…', async () => {
      const bytes = await buildImagesPdfBytes();
      const doc = await addDoc('foto-ke-pdf.pdf', bytes, 'Gambar ke PDF');
      state.activeDocId = doc.id;
      renderDocList();
      await refreshModeForDocs();
      toast(`Dokumen baru "foto-ke-pdf.pdf" dibuat (${doc.pageCount} halaman) dan dijadikan dokumen aktif.`, 'success', 5200);
    });
  }

  async function exportImagesAsPdf() {
    if (!state.imgPages.length) return;
    await withBusy('Membuat PDF…', async () => {
      const bytes = await buildImagesPdfBytes();
      downloadBlob(pdfBlob(bytes), 'foto-ke-pdf.pdf');
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
     MODE 5 - Kompres PDF
     ========================================================================== */
  // Hanya merapikan struktur berkas. Teks tetap utuh, pengecilan biasanya kecil.
  async function compressLossless(bytes) {
    const pdfDoc = await PDFDocument.load(toArrayBufferCopy(bytes));
    return pdfDoc.save({ useObjectStreams: true });
  }

  // Setiap halaman dirender ulang menjadi JPEG. Pengecilan besar untuk hasil scan,
  // tetapi teks berubah jadi gambar.
  async function compressRaster(doc, preset) {
    const newDoc = await PDFDocument.create();
    for (let i = 0; i < doc.pageCount; i++) {
      setBusyLabel(`Mengompres halaman ${i + 1}/${doc.pageCount}`);
      await tick();

      const page = await doc.preview.getPage(i + 1);
      // getViewport() sudah menerapkan rotasi bawaan halaman, sehingga halaman
      // landscape atau yang diputar tidak terpotong.
      const viewport = page.getViewport({ scale: preset.scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      // JPEG tidak punya alpha; tanpa alas putih area transparan menjadi hitam.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;

      const dataUrl = canvas.toDataURL('image/jpeg', preset.quality);
      // Ukuran halaman dikembalikan ke poin aslinya agar dimensi cetak tidak berubah.
      const pw = viewport.width / preset.scale;
      const ph = viewport.height / preset.scale;
      const newPage = newDoc.addPage([pw, ph]);
      const embedded = await newDoc.embedJpg(dataUrlToUint8Array(dataUrl));
      newPage.drawImage(embedded, { x: 0, y: 0, width: pw, height: ph });

      canvas.width = 0;
      canvas.height = 0;
    }
    return newDoc.save({ useObjectStreams: true });
  }

  function describeCompress(before, after) {
    const saved = before - after;
    const percent = before > 0 ? (saved / before) * 100 : 0;
    return { saved, percent };
  }

  async function runCompress(applyToDoc) {
    const doc = getActiveDoc();
    if (!doc) return;
    const method = state.compressOpts.method;
    const preset = COMPRESS_PRESETS[state.compressOpts.quality] || COMPRESS_PRESETS.sedang;

    await withBusy(method === 'raster' ? 'Mengompres (rasterisasi)…' : 'Mengompres…', async () => {
      const before = doc.size;
      const bytes = method === 'raster' ? await compressRaster(doc, preset) : await compressLossless(doc.bytes);
      const after = bytes.length;
      const { percent } = describeCompress(before, after);

      const methodLabel = method === 'raster' ? `Kuat — ${preset.label}` : 'Aman (lossless)';

      if (after >= before) {
        el.compressResult.innerHTML = `<b>Tidak ada penghematan.</b><br>Metode: ${methodLabel}<br>`
          + `Ukuran asli ${formatBytes(before)} → hasil ${formatBytes(after)}.<br>`
          + `<span class="muted">Dokumen dibiarkan apa adanya.</span>`;
        toast(method === 'raster'
          ? 'Hasil rasterisasi malah lebih besar — PDF ini kemungkinan berisi teks murni. Dokumen tidak diubah.'
          : 'PDF ini sudah efisien, tidak ada yang bisa dihemat. Dokumen tidak diubah.', 'warning', 7000);
        return;
      }

      el.compressResult.innerHTML = `<b>Berhasil dikecilkan ${percent.toFixed(1)}%.</b><br>`
        + `Metode: ${methodLabel}<br>`
        + `Ukuran asli ${formatBytes(before)} → hasil <b>${formatBytes(after)}</b>.`;

      if (applyToDoc) {
        await updateDocBytes(doc, bytes, `Kompres ${method === 'raster' ? 'kuat' : 'aman'}`);
        toast(`"${doc.name}" dikecilkan ${percent.toFixed(1)}% (${formatBytes(before)} → ${formatBytes(after)}).`, 'success', 5200);
      } else {
        downloadBlob(pdfBlob(bytes), withSuffix(doc.name, '-kompres'));
        toast(`Hasil kompresi diunduh (${formatBytes(before)} → ${formatBytes(after)}).`, 'success');
      }
    });
  }

  function renderCompressPanel() {
    const doc = getActiveDoc();
    const isRaster = state.compressOpts.method === 'raster';
    el.compressWarning.classList.toggle('hidden', !isRaster);
    el.compressQuality.disabled = !isRaster;

    if (!doc) {
      el.compressTitle.textContent = 'Kompres PDF';
      el.compressMeta.textContent = 'Pilih dokumen aktif untuk mulai.';
      el.compressStatusChip.textContent = 'Menunggu dokumen';
      el.compressStatusChip.className = 'chip neutral';
      el.compressInfo.textContent = 'Belum ada dokumen aktif.';
      return;
    }

    el.compressTitle.textContent = doc.name;
    el.compressMeta.textContent = `${doc.pageCount} halaman • ukuran sekarang ${formatBytes(doc.size)}`;
    el.compressStatusChip.textContent = formatBytes(doc.size);
    el.compressStatusChip.className = 'chip';
    el.compressInfo.textContent = `${doc.name} • ${doc.pageCount} halaman • ${formatBytes(doc.size)}`;
  }

  /* ==========================================================================
     Keyboard
     ========================================================================== */
  const MODE_ORDER = ['page', 'image', 'merge', 'img2pdf', 'compress'];

  function saveActiveMode() {
    if (state.mode === 'page') return exportBatchSelected();
    if (state.mode === 'image') return exportEditorPdf();
    if (state.mode === 'merge') return exportMergedPdf();
    if (state.mode === 'compress') return runCompress(false);
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

    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ['1', '2', '3', '4', '5'].indexOf(ev.key) !== -1) {
      setMode(MODE_ORDER[Number(ev.key) - 1]);
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

  // Panel Dokumen bersama
  makeDropzone(el.docDrop, handleDocFiles, el.docInput);
  el.docInput.addEventListener('change', async ev => {
    if (ev.target.files && ev.target.files.length) await handleDocFiles(ev.target.files);
    ev.target.value = '';
  });
  el.docDownloadAllBtn.addEventListener('click', downloadAllDocsZip);
  el.docClearBtn.addEventListener('click', clearDocs);
  el.docUndoBtn.addEventListener('click', async () => {
    const doc = getActiveDoc();
    if (!doc || !doc.prevBytes) return;
    await withBusy('Membatalkan langkah terakhir…', async () => {
      await undoDoc(doc);
      toast(`Langkah terakhir pada "${doc.name}" dibatalkan.`, 'success');
    });
  });

  // Mode 1 - Page Remover
  makeDropzone(el.batchEmptyDrop, handleDocFiles, el.docInput);
  el.batchApplyBtn.addEventListener('click', applyBatchActive);
  el.batchApplyAllBtn.addEventListener('click', applyBatchAll);
  el.saveBatchSelectedBtn.addEventListener('click', exportBatchSelected);
  el.saveBatchAllBtn.addEventListener('click', exportBatchAll);

  // Mode 2 - Tempel Gambar
  makeDropzone(el.editorEmptyDrop, handleDocFiles, el.docInput);
  el.imageInput.addEventListener('change', async ev => {
    if (ev.target.files && ev.target.files.length) await addImageFiles(ev.target.files, null);
    ev.target.value = '';
  });
  el.editorApplyBtn.addEventListener('click', applyEditorToDoc);
  el.saveEditorBtn.addEventListener('click', exportEditorPdf);
  el.clearEditorBtn.addEventListener('click', clearEditorOverlays);
  document.addEventListener('paste', handlePaste);

  // Mode 3 - Gabung PDF
  makeDropzone(el.mergeDrop, handleMergeFiles, el.mergePdfInput);
  makeDropzone(el.mergeEmptyDrop, handleMergeFiles, el.mergePdfInput);
  el.mergePdfInput.addEventListener('change', async ev => {
    if (ev.target.files && ev.target.files.length) await handleMergeFiles(ev.target.files);
    ev.target.value = '';
  });
  el.mergeRefreshBtn.addEventListener('click', async () => {
    state.mergeInitialized = true;
    await rebuildMergeFromDocs();
    toast('Urutan halaman disusun ulang dari daftar dokumen.', 'info');
  });
  el.mergeImageSize.addEventListener('change', ev => { state.mergeImageSize = ev.target.value; });
  el.mergeApplyBtn.addEventListener('click', applyMergeAsDoc);
  el.mergeSaveBtn.addEventListener('click', exportMergedPdf);
  el.mergeResetBtn.addEventListener('click', resetMerge);

  // Mode 4 - Gambar ke PDF
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
  el.imgApplyBtn.addEventListener('click', applyImagesAsDoc);
  el.imgSaveBtn.addEventListener('click', exportImagesAsPdf);
  el.imgResetBtn.addEventListener('click', resetImgDoc);

  // Mode 5 - Kompres PDF
  makeDropzone(el.compressEmptyDrop, handleDocFiles, el.docInput);
  el.compressMethod.addEventListener('change', ev => {
    state.compressOpts.method = ev.target.value;
    renderCompressPanel();
  });
  el.compressQuality.addEventListener('change', ev => { state.compressOpts.quality = ev.target.value; });
  el.compressApplyBtn.addEventListener('click', () => runCompress(true));
  el.compressDownloadBtn.addEventListener('click', () => runCompress(false));

  document.addEventListener('keydown', handleKeydown);

  /* ==========================================================================
     Init
     ========================================================================== */
  initTheme();
  renderDocList();
  updateImgButtons();
  updateMergeButtons();
  renderCompressPanel();
  setMode('page');
})();
