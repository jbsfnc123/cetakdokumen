(() => {
  const { PDFDocument } = window.PDFLib;
  const pdfjsLib = window['pdfjs-dist/build/pdf'];
  if (pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '';
  }

  const state = {
    mode: 'page',
    batchFiles: [],
    batchSelectedId: null,
    editor: null,
    selectedPage: null,
  };

  const el = {
    modePageBtn: document.getElementById('modePageBtn'),
    modeImageBtn: document.getElementById('modeImageBtn'),
    pageModeSidebar: document.getElementById('pageModeSidebar'),
    imageModeSidebar: document.getElementById('imageModeSidebar'),
    pageModeMain: document.getElementById('pageModeMain'),
    imageModeMain: document.getElementById('imageModeMain'),

    batchPdfInput: document.getElementById('batchPdfInput'),
    batchFileList: document.getElementById('batchFileList'),
    batchCurrentTitle: document.getElementById('batchCurrentTitle'),
    batchCurrentMeta: document.getElementById('batchCurrentMeta'),
    saveBatchSelectedBtn: document.getElementById('saveBatchSelectedBtn'),
    saveBatchAllBtn: document.getElementById('saveBatchAllBtn'),
    clearBatchBtn: document.getElementById('clearBatchBtn'),

    editorPdfInput: document.getElementById('editorPdfInput'),
    editorFileInfo: document.getElementById('editorFileInfo'),
    editorTitle: document.getElementById('editorTitle'),
    editorMeta: document.getElementById('editorMeta'),
    saveEditorBtn: document.getElementById('saveEditorBtn'),
    clearEditorBtn: document.getElementById('clearEditorBtn'),
    selectedPageInfo: document.getElementById('selectedPageInfo'),
    pasteImageBtn: document.getElementById('pasteImageBtn'),
    uploadImageLabel: document.getElementById('uploadImageLabel'),
    imageInput: document.getElementById('imageInput'),
    pagesContainer: document.getElementById('pagesContainer'),

    fileItemTemplate: document.getElementById('fileItemTemplate'),
    pageCardTemplate: document.getElementById('pageCardTemplate'),
  };

  function uid() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function setMode(mode) {
    state.mode = mode;
    el.modePageBtn.classList.toggle('active', mode === 'page');
    el.modeImageBtn.classList.toggle('active', mode === 'image');
    el.pageModeSidebar.classList.toggle('hidden', mode !== 'page');
    el.pageModeMain.classList.toggle('hidden', mode !== 'page');
    el.imageModeSidebar.classList.toggle('hidden', mode !== 'image');
    el.imageModeMain.classList.toggle('hidden', mode !== 'image');
  }

  async function loadPdfPreview(bytes) {
    return await pdfjsLib.getDocument({ data: new Uint8Array(bytes), disableWorker: true, useWorkerFetch: false, isEvalSupported: false }).promise;
  }

  async function moveLastPageToFirst(bytes) {
    const srcDoc = await PDFDocument.load(bytes.slice(0));
    const total = srcDoc.getPageCount();
    const pageOrder = [total - 1, ...Array.from({ length: total - 1 }, (_, i) => i)];
    const newDoc = await PDFDocument.create();
    const copiedPages = await newDoc.copyPages(srcDoc, pageOrder);
    copiedPages.forEach(p => newDoc.addPage(p));
    return { pdfDoc: newDoc, pageOrder };
  }

  async function handleBatchFiles(fileList) {
    const files = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    for (const file of files) {
      const bytes = await file.arrayBuffer();
      const preview = await loadPdfPreview(bytes);
      state.batchFiles.push({ id: uid(), file, bytes, pageCount: preview.numPages });
    }
    if (!state.batchSelectedId && state.batchFiles[0]) state.batchSelectedId = state.batchFiles[0].id;
    renderBatchFileList();
    updateBatchButtons();
  }

  function getBatchSelected() {
    return state.batchFiles.find(f => f.id === state.batchSelectedId) || null;
  }

  function renderBatchFileList() {
    const current = getBatchSelected();
    if (!state.batchFiles.length) {
      el.batchFileList.className = 'file-list empty';
      el.batchFileList.textContent = 'Belum ada file PDF.';
      el.batchCurrentTitle.textContent = 'Belum ada file dipilih';
      el.batchCurrentMeta.textContent = 'Tambahkan PDF untuk mulai.';
      return;
    }
    el.batchFileList.className = 'file-list';
    el.batchFileList.innerHTML = '';
    state.batchFiles.forEach(item => {
      const node = el.fileItemTemplate.content.firstElementChild.cloneNode(true);
      node.classList.toggle('active', item.id === state.batchSelectedId);
      node.querySelector('.file-name').textContent = item.file.name;
      node.querySelector('.page-count').textContent = `${item.pageCount} hal.`;
      node.querySelector('.file-status').textContent = 'Siap diproses: halaman terakhir menjadi halaman pertama';
      node.addEventListener('click', () => {
        state.batchSelectedId = item.id;
        renderBatchFileList();
        updateBatchButtons();
      });
      el.batchFileList.appendChild(node);
    });
    if (current) {
      el.batchCurrentTitle.textContent = current.file.name;
      el.batchCurrentMeta.textContent = `${current.pageCount} halaman. Saat simpan, halaman terakhir akan dipindah ke posisi pertama.`;
    }
  }

  function updateBatchButtons() {
    const hasFiles = state.batchFiles.length > 0;
    el.saveBatchAllBtn.disabled = !hasFiles;
    el.saveBatchSelectedBtn.disabled = !getBatchSelected();
  }

  async function exportBatchSelected() {
    const selected = getBatchSelected();
    if (!selected) return;
    const { pdfDoc } = await moveLastPageToFirst(selected.bytes);
    const bytes = await pdfDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), selected.file.name);
  }

  async function exportBatchAll() {
    const zip = new JSZip();
    for (const item of state.batchFiles) {
      const { pdfDoc } = await moveLastPageToFirst(item.bytes);
      zip.file(item.file.name, await pdfDoc.save());
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, 'hasil-pdf.zip');
  }

  function resetBatch() {
    state.batchFiles = [];
    state.batchSelectedId = null;
    el.batchPdfInput.value = '';
    renderBatchFileList();
    updateBatchButtons();
  }

  async function loadEditor(file) {
    const bytes = await file.arrayBuffer();
    const preview = await loadPdfPreview(bytes);
    state.editor = {
      id: uid(),
      file,
      bytes,
      preview,
      pageCount: preview.numPages,
      overlays: Array.from({ length: preview.numPages }, () => []),
      renderedPages: new Map(),
    };
    state.selectedPage = 0;
    el.editorFileInfo.textContent = `${file.name} • ${preview.numPages} halaman`;
    el.editorMeta.textContent = `${preview.numPages} halaman. Klik halaman untuk memilih, lalu tempel gambar.`;
    await renderEditorPages();
    updateEditorButtons();
  }

  function resetEditor() {
    state.editor = null;
    state.selectedPage = null;
    el.editorPdfInput.value = '';
    el.imageInput.value = '';
    el.editorFileInfo.textContent = 'Belum ada file PDF editor.';
    el.editorMeta.textContent = 'Pilih PDF editor untuk mulai.';
    el.selectedPageInfo.value = '-';
    el.pagesContainer.className = 'pages-grid empty-state';
    el.pagesContainer.innerHTML = `<div class="empty-card"><h3>Preview halaman editor tampil di sini</h3><p>Pilih PDF editor terlebih dahulu.</p></div>`;
    updateEditorButtons();
  }

  function updateEditorButtons() {
    const hasEditor = !!state.editor;
    const hasPage = hasEditor && Number.isInteger(state.selectedPage);
    el.saveEditorBtn.disabled = !hasEditor;
    el.pasteImageBtn.disabled = !hasPage;
    el.uploadImageLabel.classList.toggle('disabled', !hasPage);
    el.selectedPageInfo.value = hasPage ? `Hal. ${state.selectedPage + 1}` : '-';
  }

  async function renderEditorPages() {
    const file = state.editor;
    if (!file) return;
    el.pagesContainer.className = 'pages-grid';
    el.pagesContainer.innerHTML = '';

    for (let pageIndex = 0; pageIndex < file.pageCount; pageIndex++) {
      const page = await file.preview.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1.15 });
      const card = el.pageCardTemplate.content.firstElementChild.cloneNode(true);
      card.classList.toggle('active', pageIndex === state.selectedPage);
      card.dataset.pageIndex = pageIndex;
      card.querySelector('.page-title').textContent = `Halaman ${pageIndex + 1}`;
      card.querySelector('.page-footer').textContent = pageIndex === file.pageCount - 1
        ? 'Klik untuk memilih. Saat disimpan, halaman terakhir tetap dipindah menjadi halaman pertama.'
        : 'Klik untuk memilih halaman aktif.';

      const canvas = card.querySelector('.page-canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport }).promise;
      file.renderedPages.set(pageIndex, { width: viewport.width, height: viewport.height });

      const wrap = card.querySelector('.page-preview-wrap');
      wrap.addEventListener('click', () => {
        state.selectedPage = pageIndex;
        Array.from(el.pagesContainer.querySelectorAll('.page-card')).forEach(node => {
          node.classList.toggle('active', Number(node.dataset.pageIndex) === pageIndex);
        });
        updateEditorButtons();
      });

      card.querySelector('.remove-overlays-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        file.overlays[pageIndex] = [];
        renderOverlayLayer(file, pageIndex, card.querySelector('.overlay-layer'));
      });

      el.pagesContainer.appendChild(card);
      renderOverlayLayer(file, pageIndex, card.querySelector('.overlay-layer'));
    }
  }

  function renderOverlayLayer(file, pageIndex, layer) {
    const overlays = file.overlays[pageIndex];
    layer.innerHTML = '';
    overlays.forEach(overlay => {
      const div = document.createElement('div');
      div.className = 'overlay-item';
      div.style.left = `${overlay.x * 100}%`;
      div.style.top = `${overlay.y * 100}%`;
      div.style.width = `${overlay.w * 100}%`;
      div.style.height = `${overlay.h * 100}%`;

      const img = document.createElement('img');
      img.src = overlay.dataUrl;
      div.appendChild(img);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'overlay-remove';
      removeBtn.type = 'button';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        file.overlays[pageIndex] = file.overlays[pageIndex].filter(item => item.id !== overlay.id);
        renderOverlayLayer(file, pageIndex, layer);
      });
      div.appendChild(removeBtn);

      const resize = document.createElement('div');
      resize.className = 'resize-handle';
      div.appendChild(resize);
      enableOverlayInteractions(div, overlay, file, pageIndex, layer);
      layer.appendChild(div);
    });
  }

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  function enableOverlayInteractions(node, overlay, file, pageIndex, layer) {
    let mode = null;
    let startX = 0;
    let startY = 0;
    let start = null;

    function onMove(ev) {
      if (!mode) return;
      const rect = layer.getBoundingClientRect();
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;
      if (mode === 'drag') {
        overlay.x = clamp(start.x + dx, 0, 1 - overlay.w);
        overlay.y = clamp(start.y + dy, 0, 1 - overlay.h);
      } else {
        overlay.w = clamp(start.w + dx, 0.08, 1 - overlay.x);
        overlay.h = clamp(start.h + dy, 0.05, 1 - overlay.y);
      }
      node.style.left = `${overlay.x * 100}%`;
      node.style.top = `${overlay.y * 100}%`;
      node.style.width = `${overlay.w * 100}%`;
      node.style.height = `${overlay.h * 100}%`;
    }

    function onUp() {
      mode = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }

    node.addEventListener('pointerdown', (ev) => {
      if (ev.target.classList.contains('overlay-remove')) return;
      ev.stopPropagation();
      startX = ev.clientX;
      startY = ev.clientY;
      start = { x: overlay.x, y: overlay.y, w: overlay.w, h: overlay.h };
      mode = ev.target.classList.contains('resize-handle') ? 'resize' : 'drag';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function addImageOverlayFromBlob(blob) {
    if (!state.editor || !Number.isInteger(state.selectedPage)) return;
    const dataUrl = await blobToDataUrl(blob);
    const overlay = { id: uid(), dataUrl, x: 0.12, y: 0.18, w: 0.76, h: 0.22 };
    state.editor.overlays[state.selectedPage].push(overlay);
    const activeCard = Array.from(el.pagesContainer.querySelectorAll('.page-card')).find(node => Number(node.dataset.pageIndex) === state.selectedPage);
    if (activeCard) {
      renderOverlayLayer(state.editor, state.selectedPage, activeCard.querySelector('.overlay-layer'));
    }
  }

  async function handlePaste(event) {
    if (state.mode !== 'image' || !state.editor || !Number.isInteger(state.selectedPage)) return;
    const items = event.clipboardData && event.clipboardData.items ? event.clipboardData.items : [];
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) {
          await addImageOverlayFromBlob(blob);
          event.preventDefault();
          return;
        }
      }
    }
  }

  async function exportEditorPdf() {
    if (!state.editor) return;
    const { pdfDoc, pageOrder } = await moveLastPageToFirst(state.editor.bytes);
    const originalToNewIndex = new Map();
    pageOrder.forEach((originalIndex, newIndex) => originalToNewIndex.set(originalIndex, newIndex));

    for (let originalIndex = 0; originalIndex < state.editor.pageCount; originalIndex++) {
      const overlays = state.editor.overlays[originalIndex];
      if (!overlays.length) continue;
      const page = pdfDoc.getPage(originalToNewIndex.get(originalIndex));
      const { width, height } = page.getSize();
      for (const overlay of overlays) {
        const bytes = await fetch(overlay.dataUrl).then(r => r.arrayBuffer());
        const mime = overlay.dataUrl.substring(5, overlay.dataUrl.indexOf(';'));
        const image = mime.includes('png') ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
        const drawW = width * overlay.w;
        const drawH = height * overlay.h;
        const x = width * overlay.x;
        const yTop = height * overlay.y;
        const y = height - yTop - drawH;
        page.drawImage(image, { x, y, width: drawW, height: drawH });
      }
    }
    const bytes = await pdfDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), state.editor.file.name);
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

  el.modePageBtn.addEventListener('click', () => setMode('page'));
  el.modeImageBtn.addEventListener('click', () => setMode('image'));
  el.batchPdfInput.addEventListener('change', async (e) => { if (e.target.files?.length) await handleBatchFiles(e.target.files); });
  el.saveBatchSelectedBtn.addEventListener('click', exportBatchSelected);
  el.saveBatchAllBtn.addEventListener('click', exportBatchAll);
  el.clearBatchBtn.addEventListener('click', resetBatch);

  el.editorPdfInput.addEventListener('change', async (e) => { const file = e.target.files?.[0]; if (file) await loadEditor(file); });
  el.imageInput.addEventListener('change', async (e) => { const file = e.target.files?.[0]; if (file) await addImageOverlayFromBlob(file); e.target.value = ''; });
  el.pasteImageBtn.addEventListener('click', () => alert('Silakan copy area gambar/tabel dari Excel, klik halaman aktif, lalu tekan Ctrl+V. Jika browser tidak mengizinkan paste gambar, gunakan tombol Pilih gambar.'));
  el.saveEditorBtn.addEventListener('click', exportEditorPdf);
  el.clearEditorBtn.addEventListener('click', resetEditor);
  document.addEventListener('paste', handlePaste);

  setMode('page');
  renderBatchFileList();
  resetEditor();
  updateBatchButtons();
})();
