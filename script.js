const { PDFDocument } = PDFLib;

const state = {
  files: [],
  processed: new Map(),
};

const pdfFilesInput = document.getElementById('pdfFiles');
const dropzone = document.getElementById('dropzone');
const processBtn = document.getElementById('processBtn');
const downloadZipBtn = document.getElementById('downloadZipBtn');
const clearBtn = document.getElementById('clearBtn');
const fileCounter = document.getElementById('fileCounter');
const fileList = document.getElementById('fileList');
const summaryText = document.getElementById('summaryText');
const statusLog = document.getElementById('statusLog');

pdfFilesInput.addEventListener('change', (event) => addFiles(event.target.files));
processBtn.addEventListener('click', processAllFiles);
downloadZipBtn.addEventListener('click', downloadAllAsZip);
clearBtn.addEventListener('click', resetAll);

['dragenter', 'dragover'].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropzone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropzone.classList.remove('dragover');
  });
});

dropzone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));

function addFiles(fileListLike) {
  const incoming = Array.from(fileListLike || []).filter(
    (file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  );

  if (!incoming.length) {
    setStatus('Tidak ada file PDF yang valid.');
    return;
  }

  const existingKeys = new Set(state.files.map((file) => `${file.name}_${file.size}_${file.lastModified}`));

  for (const file of incoming) {
    const key = `${file.name}_${file.size}_${file.lastModified}`;
    if (!existingKeys.has(key)) {
      state.files.push(file);
      existingKeys.add(key);
    }
  }

  state.processed.clear();
  updateUI();
  setStatus(`Total ${state.files.length} file siap diproses.`);
}

function resetAll() {
  state.files = [];
  state.processed.clear();
  pdfFilesInput.value = '';
  updateUI();
  setStatus('Data direset. Silakan pilih file PDF lagi.');
}

function updateUI() {
  const total = state.files.length;
  fileCounter.textContent = `${total} file dipilih`;
  summaryText.textContent = total ? `${state.processed.size} dari ${total} file sudah diproses` : 'Belum ada file';

  processBtn.disabled = total === 0;
  clearBtn.disabled = total === 0;
  downloadZipBtn.disabled = state.processed.size === 0;

  if (!total) {
    fileList.className = 'file-list empty';
    fileList.innerHTML = '<div class="empty-state">Tambahkan file PDF untuk mulai memproses.</div>';
    return;
  }

  fileList.className = 'file-list';
  fileList.innerHTML = '';

  state.files.forEach((file, index) => {
    const processed = state.processed.get(file.name);
    const statusClass = processed?.status || 'pending';
    const statusTextMap = {
      pending: 'Belum diproses',
      processing: 'Diproses',
      done: 'Selesai',
      error: 'Error',
    };

    const row = document.createElement('div');
    row.className = 'file-item';
    row.innerHTML = `
      <div>
        <div class="file-name">${index + 1}. ${escapeHtml(file.name)}</div>
        <div class="file-meta">${formatBytes(file.size)}</div>
      </div>
      <div class="file-meta">${processed?.pageInfo || '-'}</div>
      <div class="file-status ${statusClass}">${statusTextMap[statusClass]}</div>
      <div>
        <button class="inline-btn" ${processed?.status === 'done' ? '' : 'disabled'} data-download="${escapeAttr(file.name)}">
          Download
        </button>
      </div>
    `;
    fileList.appendChild(row);
  });

  fileList.querySelectorAll('[data-download]').forEach((button) => {
    button.addEventListener('click', () => downloadSingle(button.dataset.download));
  });
}

async function processAllFiles() {
  if (!state.files.length) return;

  setStatus('Memulai proses semua file...');
  downloadZipBtn.disabled = true;

  for (const file of state.files) {
    state.processed.set(file.name, { status: 'processing', pageInfo: 'Membaca file...' });
    updateUI();

    try {
      const result = await rotateLastPageToFront(file);
      state.processed.set(file.name, {
        status: 'done',
        blob: result.blob,
        pageInfo: `${result.pageCount} halaman -> urutan ${result.orderPreview}`,
      });
      setStatus(`Sukses: ${file.name}`);
    } catch (error) {
      console.error(error);
      state.processed.set(file.name, {
        status: 'error',
        pageInfo: error.message || 'Gagal memproses file',
      });
      setStatus(`Gagal: ${file.name}\n${error.message || error}`);
    }

    updateUI();
  }

  if ([...state.processed.values()].some((item) => item.status === 'done')) {
    downloadZipBtn.disabled = false;
    appendStatus('\nSemua proses selesai. Anda bisa download satu per satu atau sekaligus dalam ZIP.');
  }
}

async function rotateLastPageToFront(file) {
  const bytes = await file.arrayBuffer();
  const srcPdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const pageCount = srcPdf.getPageCount();

  if (pageCount < 2) {
    throw new Error('PDF minimal harus memiliki 2 halaman.');
  }

  const newPdf = await PDFDocument.create();
  const pageOrder = [pageCount - 1, ...Array.from({ length: pageCount - 1 }, (_, i) => i)];
  const copiedPages = await newPdf.copyPages(srcPdf, pageOrder);
  copiedPages.forEach((page) => newPdf.addPage(page));

  const output = await newPdf.save();
  return {
    blob: new Blob([output], { type: 'application/pdf' }),
    pageCount,
    orderPreview: `${pageCount},1,2${pageCount > 3 ? ',...' : ''}`,
  };
}

function downloadSingle(fileName) {
  const item = state.processed.get(fileName);
  if (!item?.blob) return;
  downloadBlob(item.blob, fileName);
}

async function downloadAllAsZip() {
  const zip = new JSZip();
  let added = 0;

  for (const file of state.files) {
    const item = state.processed.get(file.name);
    if (item?.status === 'done' && item.blob) {
      zip.file(file.name, item.blob);
      added += 1;
    }
  }

  if (!added) {
    setStatus('Belum ada file hasil proses untuk di-download.');
    return;
  }

  setStatus('Membuat file ZIP...');
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(zipBlob, 'hasil-pdf-rotasi.zip');
  appendStatus('\nZIP berhasil dibuat dan di-download.');
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setStatus(message) {
  statusLog.textContent = message;
}

function appendStatus(message) {
  statusLog.textContent += message;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function escapeAttr(text) {
  return text.replace(/"/g, '&quot;');
}

updateUI();
