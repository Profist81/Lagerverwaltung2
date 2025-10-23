/* Lagerverwaltung – App Logic (ohne externe Abhängigkeiten) */

/* ---------- Small Utilities ---------- */
const U = (() => {
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const sanitize = (s) => (s ?? "").replace(/[<>]/g, "");
  const normLs = (s) => sanitize(String(s)).replace(/[\s._-]+/g, "").toUpperCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uuid = () =>
    (crypto.randomUUID ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }));

  async function sha256(buf) {
    const ab = buf instanceof ArrayBuffer ? buf : await buf.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", ab);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function download(name, mime, data) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function csvEscape(v) {
    const s = String(v ?? "");
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  const isDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  return { $, $$, todayStr, sanitize, normLs, sleep, uuid, sha256, download, csvEscape, isDateStr };
})();

/* ---------- IndexedDB Wrapper ---------- */
const DB = (() => {
  const DB_NAME = "lagerverwaltung";
  const DB_VER = 1;
  let dbp;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = req.result;

        // inbound docs
        if (!db.objectStoreNames.contains("inbound_docs")) {
          const os = db.createObjectStore("inbound_docs", { keyPath: "id" });
          os.createIndex("by_status", "status", { unique: false });
          os.createIndex("by_date", "date_doc", { unique: false });
          os.createIndex("by_lsnorm", "ls_nr_normalized", { unique: false });
          os.createIndex("by_supplier", "supplier", { unique: false });
        }

        // images
        if (!db.objectStoreNames.contains("inbound_images")) {
          const os = db.createObjectStore("inbound_images", { keyPath: "id" });
          os.createIndex("by_inbound", "inbound_id", { unique: false });
          os.createIndex("by_inbound_page", ["inbound_id", "page_no"], { unique: true });
          os.createIndex("by_sha", "sha256", { unique: false });
        }

        // dnd items
        if (!db.objectStoreNames.contains("dnd_items")) {
          const os = db.createObjectStore("dnd_items", { keyPath: "id" });
          os.createIndex("by_zone", "zone", { unique: false });
        }

        // cart
        if (!db.objectStoreNames.contains("cart")) {
          db.createObjectStore("cart", { keyPath: "id" });
        }

        // logs
        if (!db.objectStoreNames.contains("logs")) {
          const os = db.createObjectStore("logs", { keyPath: "id" });
          os.createIndex("by_inbound", "inbound_id", { unique: false });
        }

        // settings
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(mode, ...stores) {
    const db = await open();
    return db.transaction(stores, mode);
  }

  /* Inbound Docs */
  async function addInboundDoc(doc) {
    const t = await tx("readwrite", "inbound_docs");
    await t.objectStore("inbound_docs").add(doc);
    return doc;
  }
  async function putInboundDoc(doc) {
    const t = await tx("readwrite", "inbound_docs");
    await t.objectStore("inbound_docs").put(doc);
    return doc;
  }
  async function getInboundById(id) {
    const t = await tx("readonly", "inbound_docs");
    return t.objectStore("inbound_docs").get(id);
  }
  async function findInboundByLs(lsnorm) {
    const t = await tx("readonly", "inbound_docs");
    const idx = t.objectStore("inbound_docs").index("by_lsnorm");
    const out = [];
    await iterIndex(idx, IDBKeyRange.only(lsnorm), (v) => out.push(v));
    return out;
  }
  async function listInboundByStatus(status) {
    const t = await tx("readonly", "inbound_docs");
    const idx = t.objectStore("inbound_docs").index("by_status");
    const out = [];
    await iterIndex(idx, IDBKeyRange.only(status), (v) => out.push(v));
    out.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
    return out;
  }
  async function listInboundByDate(dateStr) {
    const t = await tx("readonly", "inbound_docs");
    const idx = t.objectStore("inbound_docs").index("by_date");
    const out = [];
    await iterIndex(idx, IDBKeyRange.only(dateStr), (v) => out.push(v));
    out.sort((a, b) => a.ls_nr.localeCompare(b.ls_nr));
    return out;
  }

  /* Images */
  async function addImage(img) {
    const t = await tx("readwrite", "inbound_images");
    await t.objectStore("inbound_images").add(img);
    return img;
  }
  async function putImage(img) {
    const t = await tx("readwrite", "inbound_images");
    await t.objectStore("inbound_images").put(img);
  }
  async function listImages(inbound_id) {
    const t = await tx("readonly", "inbound_images");
    const idx = t.objectStore("inbound_images").index("by_inbound");
    const out = [];
    await iterIndex(idx, IDBKeyRange.only(inbound_id), (v) => out.push(v));
    out.sort((a, b) => a.page_no - b.page_no);
    return out;
  }
  async function countImages(inbound_id) {
    const t = await tx("readonly", "inbound_images");
    const idx = t.objectStore("inbound_images").index("by_inbound");
    return new Promise((resolve, reject) => {
      const req = idx.count(IDBKeyRange.only(inbound_id));
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    });
  }
  async function deleteImage(id) {
    const t = await tx("readwrite", "inbound_images");
    await t.objectStore("inbound_images").delete(id);
  }

  /* DnD Items */
  async function listItemsByZone(zone) {
    const t = await tx("readonly", "dnd_items");
    const idx = t.objectStore("dnd_items").index("by_zone");
    const out = [];
    await iterIndex(idx, IDBKeyRange.only(zone), (v) => out.push(v));
    return out;
  }
  async function putItem(it) {
    const t = await tx("readwrite", "dnd_items");
    await t.objectStore("dnd_items").put(it);
  }
  async function getItem(id) {
    const t = await tx("readonly", "dnd_items");
    return t.objectStore("dnd_items").get(id);
  }
  async function deleteItem(id) {
    const t = await tx("readwrite", "dnd_items");
    await t.objectStore("dnd_items").delete(id);
  }

  /* Cart */
  async function getCartAll() {
    const t = await tx("readonly", "cart");
    return new Promise((resolve, reject) => {
      const req = t.objectStore("cart").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  async function putCart(item) {
    const t = await tx("readwrite", "cart");
    await t.objectStore("cart").put(item);
  }
  async function delCart(id) {
    const t = await tx("readwrite", "cart");
    await t.objectStore("cart").delete(id);
  }
  async function clearCart() {
    const t = await tx("readwrite", "cart");
    await t.objectStore("cart").clear();
  }

  /* Logs */
  async function addLog(log) {
    const t = await tx("readwrite", "logs");
    await t.objectStore("logs").add({ id: U.uuid(), ...log, ts: new Date().toISOString() });
  }

  /* Settings */
  async function setSetting(key, value) {
    const t = await tx("readwrite", "settings");
    await t.objectStore("settings").put({ key, value });
  }
  async function getSetting(key, defVal = null) {
    const t = await tx("readonly", "settings");
    const v = await t.objectStore("settings").get(key);
    return v ? v.value : defVal;
  }

  async function iterIndex(index, range, onval) {
    return new Promise((resolve, reject) => {
      const req = index.openCursor(range);
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) { onval(cur.value); cur.continue(); }
        else resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  return {
    addInboundDoc, putInboundDoc, getInboundById,
    findInboundByLs, listInboundByStatus, listInboundByDate,
    addImage, putImage, listImages, countImages, deleteImage,
    listItemsByZone, putItem, getItem, deleteItem,
    getCartAll, putCart, delCart, clearCart,
    addLog, setSetting, getSetting
  };
})();

/* ---------- Camera & Image Tools ---------- */
const Camera = (() => {
  const state = {
    inboundId: null,
    stream: null,
    captures: [] // {blob, w, h, sha256}
  };
  const el = {
    dlg: document.getElementById("dlgCamera"),
    video: document.getElementById("video"),
    canvas: document.getElementById("canvas"),
    img: document.getElementById("photoPreview"),
    list: document.getElementById("captureList"),
    fileInput: document.getElementById("fileInput"),
    btnTake: document.getElementById("btnTake"),
    btnRotate: document.getElementById("btnRotate"),
    btnRetake: document.getElementById("btnRetake"),
    btnDeleteLast: document.getElementById("btnDeleteLast"),
    btnDone: document.getElementById("btnDone"),
  };

  function reset() {
    state.captures = [];
    renderThumbs();
    el.img.classList.add("hidden");
    el.canvas.classList.add("hidden");
  }

  async function open(inboundId) {
    state.inboundId = inboundId;
    reset();
    try {
      if (navigator.mediaDevices?.getUserMedia) {
        state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        el.video.srcObject = state.stream;
        el.video.classList.remove("hidden");
      } else {
        // fallback
        el.video.classList.add("hidden");
        el.fileInput.classList.remove("hidden");
      }
    } catch {
      el.video.classList.add("hidden");
      el.fileInput.classList.remove("hidden");
    }
    el.dlg.showModal();
  }

  async function stop() {
    if (state.stream) {
      state.stream.getTracks().forEach(t => t.stop());
      state.stream = null;
    }
  }

  function renderThumbs() {
    el.list.innerHTML = "";
    state.captures.forEach((c, i) => {
      const url = URL.createObjectURL(c.blob);
      const item = document.createElement("div");
      item.className = "thumb";
      item.innerHTML = `<img alt="Seite ${i + 1}" src="${url}"><span>${i + 1}</span>`;
      el.list.appendChild(item);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  }

  function rotateLast() {
    if (!state.captures.length) return;
    const last = state.captures[state.captures.length - 1];
    return rotateBlob(last.blob, 90).then(async (rotBlob) => {
      const sha = await U.sha256(rotBlob);
      state.captures[state.captures.length - 1] = { blob: rotBlob, w: last.h, h: last.w, sha256: sha };
      renderThumbs();
    });
  }

  function deleteLast() {
    state.captures.pop();
    renderThumbs();
  }

  async function take() {
    if (state.stream) {
      const v = el.video;
      const maxEdge = Math.max(v.videoWidth, v.videoHeight);
      if (maxEdge < 1500) {
        await UI.message("Foto unscharf/zu dunkel. Erneut aufnehmen?");
        return;
      }
      const blob = await captureVideoToBlob(v);
      const ok = await validateBlob(blob);
      if (!ok) {
        await UI.message("Foto unscharf/zu dunkel. Erneut aufnehmen?");
        return;
      }
      const sha = await U.sha256(blob);
      state.captures.push({ blob, w: v.videoWidth, h: v.videoHeight, sha256: sha });
      renderThumbs();
    } else {
      el.fileInput.click();
    }
  }

  async function onFilePicked(file) {
    if (!file) return;
    // Try EXIF-aware decode
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // fallback decode via <img>
      const img = document.createElement("img");
      const url = URL.createObjectURL(file);
      await new Promise((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = url; });
      bmp = await createImageBitmap(img);
      URL.revokeObjectURL(url);
    }
    const blob = await drawBitmapToBlob(bmp);
    const ok = await validateBlob(blob);
    if (!ok) {
      await UI.message("Foto unscharf/zu dunkel. Erneut aufnehmen?");
      return;
    }
    const sha = await U.sha256(blob);
    state.captures.push({ blob, w: bmp.width, h: bmp.height, sha256: sha });
    renderThumbs();
  }

  async function saveAll() {
    // persist images
    const existing = await DB.listImages(state.inboundId);
    let page = existing.length ? Math.max(...existing.map(i => i.page_no)) : 0;
    for (const cap of state.captures) {
      page += 1;
      const id = U.uuid();
      const storage_uri = `blob://inbound/${new Date().toISOString().slice(0, 10).replaceAll("-", "/")}/${state.inboundId}/p${String(page).padStart(3, "0")}.jpg`;
      await DB.addImage({
        id, inbound_id: state.inboundId, page_no: page,
        mime_type: "image/jpeg",
        width_px: cap.w, height_px: cap.h, size_bytes: cap.blob.size,
        sha256: cap.sha256, storage_uri,
        created_at: new Date().toISOString(), created_by: App.userId(),
        synced: false, blob: cap.blob
      });
      await DB.addLog({ action: "add_image", inbound_id: state.inboundId, image_id: id, user: App.userId() });
    }
    state.captures = [];
    renderThumbs();
    await UI.refreshLists();
    UI.bumpSyncBadge();
  }

  async function captureVideoToBlob(video) {
    const max = 2500;
    const cw = video.videoWidth;
    const ch = video.videoHeight;
    const scale = Math.min(1, max / Math.max(cw, ch));
    const w = Math.round(cw * scale);
    const h = Math.round(ch * scale);
    const c = el.canvas;
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);
    // compress
    return new Promise((res) => c.toBlob(b => res(b), "image/jpeg", 0.85));
  }

  async function drawBitmapToBlob(bmp) {
    const max = 2500;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const c = el.canvas;
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0, w, h);
    return new Promise((res) => c.toBlob(b => res(b), "image/jpeg", 0.85));
  }

  async function validateBlob(blob) {
    // Resolution + simple blur via Laplacian variance
    const bmp = await createImageBitmap(blob);
    if (Math.max(bmp.width, bmp.height) < 1500) return false;
    const score = await laplacianVariance(bmp);
    // heuristic threshold
    return score >= 60;
  }

  async function laplacianVariance(bmp) {
    // compute on scaled down canvas for speed
    const targetMax = 800;
    const s = Math.min(1, targetMax / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, (bmp.width * s) | 0);
    const h = Math.max(1, (bmp.height * s) | 0);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h).data;
    // grayscale
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < img.length; i += 4, p++) {
      gray[p] = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
    }
    const k = [0, 1, 0, 1, -4, 1, 0, 1, 0];
    const out = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const v =
          k[0] * gray[i - w - 1] + k[1] * gray[i - w] + k[2] * gray[i - w + 1] +
          k[3] * gray[i - 1]     + k[4] * gray[i]     + k[5] * gray[i + 1] +
          k[6] * gray[i + w - 1] + k[7] * gray[i + w] + k[8] * gray[i + w + 1];
        out[i] = v;
      }
    }
    // variance
    let sum = 0, sum2 = 0, n = (w - 2) * (h - 2);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const v = out[y * w + x];
        sum += v; sum2 += v * v;
      }
    }
    const mean = sum / n;
    const varr = (sum2 / n) - (mean * mean);
    return varr / 100; // scale
  }

  async function rotateBlob(blob, deg) {
    const bmp = await createImageBitmap(blob);
    const rad = deg * Math.PI / 180;
    const s = Math.sin(rad), c = Math.cos(rad);
    const w = Math.abs(bmp.width * c) + Math.abs(bmp.height * s);
    const h = Math.abs(bmp.width * s) + Math.abs(bmp.height * c);
    const cnv = document.createElement("canvas");
    cnv.width = Math.round(w); cnv.height = Math.round(h);
    const ctx = cnv.getContext("2d");
    ctx.translate(cnv.width / 2, cnv.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    return new Promise((res) => cnv.toBlob(b => res(b), "image/jpeg", 0.9));
  }

  // Event wiring
  el.btnTake.addEventListener("click", take);
  el.btnRotate.addEventListener("click", rotateLast);
  el.btnRetake.addEventListener("click", deleteLast);
  el.btnDeleteLast.addEventListener("click", deleteLast);
  el.btnDone.addEventListener("click", async (e) => {
    e.preventDefault();
    await saveAll();
    el.dlg.close();
    stop();
  });
  el.fileInput.addEventListener("change", (e) => onFilePicked(e.target.files[0]));

  return { open, stop };
})();

/* ---------- UI Layer ---------- */
const UI = (() => {
  const el = {
    roleBadge: U.$("#roleBadge"),
    syncBadge: U.$("#syncBadge"),
    onlineBadge: U.$("#onlineBadge"),
    supplierList: U.$("#supplierList"),
    formInbound: U.$("#formInbound"),
    dupWarning: U.$("#dupWarning"),
    chkForce: U.$("#chkForce"),
    lsnr: U.$("#lsnr"),
    supplier: U.$("#supplier"),
    dateDoc: U.$("#dateDoc"),
    btnSaveOnly: U.$("#btnSaveOnly"),
    listOhne: U.$("#listOhne"),
    listMit: U.$("#listMit"),
    results: U.$("#results"),
    quickSearch: U.$("#quickSearch"),
    btnSearch: U.$("#btnSearch"),
    board: U.$("#board"),
    toggleAskPartial: U.$("#toggleAskPartial"),
    btnAddBin: U.$("#btnAddBin"),
    cartTableBody: U.$("#cartTable tbody"),
    adminPanel: U.$("#adminPanel"),
    toggleHomeLock: U.$("#toggleHomeLock"),
    toggleOverride: U.$("#toggleOverride"),
    dlgConfirm: U.$("#dlgConfirm"),
    dlgMsg: U.$("#dlgMessage"),
    msgText: U.$("#msgText"),
    dlgPrompt: U.$("#dlgPrompt"),
    promptLabel: U.$("#promptLabel"),
    promptInput: U.$("#promptInput"),
  };

  function setOnlineUi() {
    const online = navigator.onLine;
    el.onlineBadge.textContent = online ? "Online" : "Offline";
    el.onlineBadge.className = `badge ${online ? "badge-ok" : "badge-warn"}`;
  }
  window.addEventListener("online", () => { setOnlineUi(); bumpSyncBadge(true); });
  window.addEventListener("offline", setOnlineUi);

  async function bumpSyncBadge(auto = false) {
    // Count unsynced images (synced:false)
    const ohne = await DB.listInboundByStatus("ohne_zeichnung");
    const mit = await DB.listInboundByStatus("mit_zeichnung");
    const all = [...ohne, ...mit];
    let pending = 0;
    for (const d of all) {
      const imgs = await DB.listImages(d.id);
      pending += imgs.filter(i => !i.synced).length;
    }
    el.syncBadge.textContent = `⟳ ${pending}`;
    if (auto && navigator.onLine && pending) {
      // Simulierte Synchronisation (kein echter Server in diesem Stand)
      await U.sleep(300);
      for (const d of all) {
        const imgs = await DB.listImages(d.id);
        for (const im of imgs) {
          if (!im.synced) { im.synced = true; await DB.putImage(im); }
        }
      }
      await U.sleep(100);
      el.syncBadge.textContent = "⟳ 0";
      note("Upload ausstehend – wird bei Verbindung synchronisiert.");
    }
  }

  function setRole(isAdmin) {
    el.roleBadge.textContent = isAdmin ? "Admin" : "Gast";
    el.roleBadge.className = `badge ${isAdmin ? "badge-admin" : ""}`;
    el.adminPanel.hidden = !isAdmin;
  }

  function note(text) {
    // Non-blocking toast-like message
    console.info(text);
  }

  function tile(doc, pages) {
    const icon = `📎 ×${pages || 0}`;
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `
      <div class="li-main">
        <b>${doc.ls_nr}</b> – ${doc.supplier} – ${doc.date_doc}
      </div>
      <div class="li-sub">
        <span>${icon}</span>
        ${!doc.syncedAll ? `<span class="badge badge-info">Upload ausstehend – wird bei Verbindung synchronisiert.</span>` : ""}
      </div>
      <div class="li-actions">
        <button class="btn btn-ghost" data-act="open">${pages ? "Anzeigen" : "Fotografieren"}</button>
        <button class="btn btn-ghost" data-act="manage">Bilder verwalten</button>
      </div>
    `;
    li.dataset.id = doc.id;
    return li;
  }

  async function refreshLists() {
    // suppliers datalist (simple)
    const mit = await DB.listInboundByStatus("mit_zeichnung");
    const ohne = await DB.listInboundByStatus("ohne_zeichnung");
    const all = [...mit, ...ohne];
    const uniqSupp = [...new Set(all.map(d => d.supplier))].sort();
    el.supplierList.innerHTML = uniqSupp.map(s => `<option value="${s}">`).join("");

    // Lists
    el.listOhne.innerHTML = "";
    for (const d of ohne) {
      const pages = await DB.countImages(d.id);
      const li = tile(d, pages);
      el.listOhne.appendChild(li);
    }
    el.listMit.innerHTML = "";
    for (const d of mit) {
      const pages = await DB.countImages(d.id);
      const li = tile(d, pages);
      el.listMit.appendChild(li);
    }
  }

  function listClickHandler(ul, isOhne) {
    ul.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      const li = e.target.closest(".list-item");
      if (!btn || !li) return;
      const id = li.dataset.id;
      const doc = await DB.getInboundById(id);
      const imgs = await DB.listImages(id);

      if (btn.dataset.act === "open") {
        if (isOhne) {
          if (!imgs.length) {
            await message("Noch kein Foto vorhanden. Bitte zuerst fotografieren.");
            Camera.open(id);
            return;
          }
          const res = await confirm("Zeichnung(en) gedruckt und bei der Ware abgelegt?");
          if (res === "yes") {
            doc.status = "mit_zeichnung";
            doc.updated_at = new Date().toISOString();
            doc.updated_by = App.userId();
            await DB.putInboundDoc(doc);
            await DB.addLog({ action: "status_change", inbound_id: id, user: App.userId() });
            await refreshLists();
          }
        } else {
          // show detail gallery
          await showDetail(doc);
        }
      } else if (btn.dataset.act === "manage") {
        await manageImages(doc);
      }
    });
  }

  async function showDetail(doc) {
    const imgs = await DB.listImages(doc.id);
    const wrap = document.createElement("div");
    wrap.className = "detail";
    wrap.innerHTML = `
      <h3>${doc.ls_nr}</h3>
      <div class="meta">
        <span>Lieferant: ${doc.supplier}</span>
        <span>Datum: ${doc.date_doc}</span>
        <span>Status: ${doc.status}</span>
        <span>Seiten: ${imgs.length}</span>
      </div>
      <div class="gallery" tabindex="0" aria-label="Galerie">
        <img id="galImg" alt="Seite 1/${imgs.length}" />
        <div class="gal-ctrl">
          <button id="prev" class="btn btn-ghost">◀</button>
          <span id="counter">1/${imgs.length}</span>
          <button id="next" class="btn btn-ghost">▶</button>
          <button id="zoomIn" class="btn btn-ghost">Zoom +</button>
          <button id="zoomOut" class="btn btn-ghost">Zoom −</button>
          <button id="btnToCart" class="btn">In Korb</button>
        </div>
      </div>
    `;
    el.results.innerHTML = "";
    el.results.appendChild(wrap);

    let idx = 0, zoom = 1;
    const setImg = (i) => {
      idx = (i + imgs.length) % imgs.length;
      const cur = imgs[idx];
      const url = URL.createObjectURL(cur.blob);
      const gi = U.$("#galImg", wrap);
      gi.src = url;
      gi.style.transform = `scale(${zoom})`;
      U.$("#counter", wrap).textContent = `${idx + 1}/${imgs.length}`;
      gi.alt = `Seite ${idx + 1}/${imgs.length}`;
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    };
    U.$("#prev", wrap).onclick = () => setImg(idx - 1);
    U.$("#next", wrap).onclick = () => setImg(idx + 1);
    U.$("#zoomIn", wrap).onclick = () => { zoom = Math.min(3, zoom + 0.25); setImg(idx); };
    U.$("#zoomOut", wrap).onclick = () => { zoom = Math.max(0.5, zoom - 0.25); setImg(idx); };
    U.$("#btnToCart", wrap).onclick = async () => {
      const name = `${doc.supplier} – ${doc.ls_nr}`;
      await Cart.add(name, 1, `Datum ${doc.date_doc}`);
      await Cart.render();
      await message("Zum Korb hinzugefügt.");
    };
    if (imgs.length) setImg(0);
  }

  async function manageImages(doc) {
    const imgs = await DB.listImages(doc.id);
    const wrap = document.createElement("div");
    wrap.className = "manage";
    wrap.innerHTML = `
      <h3>Bilder verwalten</h3>
      <div class="manage-list"></div>
      <div class="row gap">
        <button id="btnAdd" class="btn">Weitere Seite</button>
        <button id="btnReorderUp" class="btn btn-ghost">▲</button>
        <button id="btnReorderDown" class="btn btn-ghost">▼</button>
        <button id="btnDelete" class="btn btn-ghost">Löschen</button>
      </div>
    `;
    el.results.innerHTML = "";
    el.results.appendChild(wrap);

    const list = U.$(".manage-list", wrap);
    let sel = -1;
    function render() {
      list.innerHTML = "";
      imgs.sort((a, b) => a.page_no - b.page_no);
      imgs.forEach((im, i) => {
        const url = URL.createObjectURL(im.blob);
        const div = document.createElement("div");
        div.className = `thumb ${sel === i ? "selected" : ""}`;
        div.innerHTML = `<img src="${url}" alt="Seite ${im.page_no}"><span>${im.page_no}</span>`;
        div.addEventListener("click", () => { sel = i; render(); });
        list.appendChild(div);
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      });
    }
    render();

    U.$("#btnAdd", wrap).onclick = () => Camera.open(doc.id);
    U.$("#btnDelete", wrap).onclick = async () => {
      if (sel < 0) return;
      const id = imgs[sel].id;
      await DB.deleteImage(id);
      await DB.addLog({ action: "delete_image", inbound_id: doc.id, image_id: id, user: App.userId() });
      imgs.splice(sel, 1); sel = -1; // reindex remaining
      let p = 1;
      for (const im of imgs) { im.page_no = p++; await DB.putImage(im); }
      render(); await refreshLists();
    };
    U.$("#btnReorderUp", wrap).onclick = async () => {
      if (sel <= 0) return;
      [imgs[sel - 1].page_no, imgs[sel].page_no] = [imgs[sel].page_no, imgs[sel - 1].page_no];
      await DB.putImage(imgs[sel - 1]); await DB.putImage(imgs[sel]);
      await DB.addLog({ action: "reorder_images", inbound_id: doc.id, user: App.userId() });
      sel = sel - 1; render();
    };
    U.$("#btnReorderDown", wrap).onclick = async () => {
      if (sel < 0 || sel >= imgs.length - 1) return;
      [imgs[sel + 1].page_no, imgs[sel].page_no] = [imgs[sel].page_no, imgs[sel + 1].page_no];
      await DB.putImage(imgs[sel + 1]); await DB.putImage(imgs[sel]);
      await DB.addLog({ action: "reorder_images", inbound_id: doc.id, user: App.userId() });
      sel = sel + 1; render();
    };
  }

  async function checkDuplicate(lsNr, supplier, date) {
    const norm = U.normLs(lsNr);
    const list = await DB.findInboundByLs(norm);
    return list.some(d => d.supplier === supplier && d.date_doc === date);
  }

  async function handleSubmit(e, andShoot) {
    e.preventDefault();
    const ls_nr = U.sanitize(el.lsnr.value).trim();
    const supplier = U.sanitize(el.supplier.value).trim();
    const date_doc = el.dateDoc.value;

    if (!ls_nr || !supplier || !date_doc) return;
    const duplicate = await checkDuplicate(ls_nr, supplier, date_doc);
    if (duplicate && !el.chkForce.checked) {
      el.dupWarning.classList.remove("hidden");
      return;
    }
    const doc = {
      id: U.uuid(),
      ls_nr,
      ls_nr_normalized: U.normLs(ls_nr),
      supplier,
      date_doc,
      status: "ohne_zeichnung",
      created_at: new Date().toISOString(),
      created_by: App.userId(),
      updated_at: null, updated_by: null
    };
    await DB.addInboundDoc(doc);
    await DB.addLog({ action: "create_doc", inbound_id: doc.id, user: App.userId() });
    el.formInbound.reset();
    el.dateDoc.value = U.todayStr();
    el.dupWarning.classList.add("hidden");
    await refreshLists();
    if (andShoot) Camera.open(doc.id);
  }

  async function search() {
    const q = el.quickSearch.value.trim();
    if (!q) return;
    el.results.innerHTML = "";
    if (U.isDateStr(q)) {
      const list = await DB.listInboundByDate(q);
      if (!list.length) { el.results.textContent = "Keine Treffer."; return; }
      const group = document.createElement("div");
      group.className = "group";
      const header = document.createElement("h3");
      header.textContent = `Treffer am ${q}`;
      group.appendChild(header);
      const ul = document.createElement("ul"); ul.className = "list";
      for (const d of list) {
        const pages = await DB.countImages(d.id);
        const li = tile(d, pages);
        ul.appendChild(li);
      }
      group.appendChild(ul);
      el.results.appendChild(group);
    } else {
      const norm = U.normLs(q);
      const hits = await DB.findInboundByLs(norm);
      if (!hits.length) { el.results.textContent = "Keine Treffer."; return; }
      const d = hits[0]; // exakt
      await showDetail(d);
    }
  }

  function dndInit() {
    // basic pointer-safe dnd
    el.board.addEventListener("dragstart", (ev) => {
      const li = ev.target.closest(".item");
      if (!li) return;
      ev.dataTransfer.setData("text/plain", li.dataset.id);
      ev.dataTransfer.effectAllowed = "move";
    });
    U.$$(".dropzone").forEach(zone => {
      zone.addEventListener("dragover", (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; });
      zone.addEventListener("drop", async (ev) => {
        ev.preventDefault();
        const id = ev.dataTransfer.getData("text/plain");
        const item = await DB.getItem(id);
        if (!item) return;
        const targetZone = zone.dataset.zone;
        let qty = item.qty;
        const ask = el.toggleAskPartial.checked || zone.dataset.askPartial === "1";
        if (ask && (ev.altKey || zone.dataset.askPartial === "1")) {
          const v = await prompt("Menge verschieben (verfügbar " + item.qty + "):", String(item.qty));
          if (v.result !== "ok") return;
          const n = Math.max(0, Math.min(item.qty, parseInt(v.value || "0", 10) || 0));
          if (n <= 0) return;
          qty = n;
        }
        if (qty < item.qty) {
          // partial move: reduce source, create/merge target
          item.qty -= qty;
          await DB.putItem(item);
          await addOrMergeItem({ name: item.name, zone: targetZone, qty, note: item.note || "" });
        } else {
          // full move
          item.zone = targetZone;
          await DB.putItem(item);
        }
        await renderBoard();
      });
    });
  }

  async function addOrMergeItem({ name, zone, qty, note }) {
    const allInZone = await DB.listItemsByZone(zone);
    const same = allInZone.find(i => i.name === name && (i.note || "") === (note || ""));
    if (same) {
      same.qty += qty;
      await DB.putItem(same);
    } else {
      await DB.putItem({ id: U.uuid(), name, zone, qty, note });
    }
  }

  async function renderBoard() {
    const zones = {
      "Bestände": U.$("#zone-best"),
      "Wareneingang": U.$("#zone-inbound"),
      "Lagerplatz": U.$("#zone-storage"),
      "Pulverbeschichtung": U.$("#zone-pbs"),
      "Roboter": U.$("#zone-robot"),
    };
    for (const key of Object.keys(zones)) zones[key].innerHTML = "";
    for (const z of Object.keys(zones)) {
      const items = await DB.listItemsByZone(z);
      for (const it of items) {
        const li = document.createElement("li");
        li.className = "item";
        li.draggable = true;
        li.dataset.id = it.id;
        li.innerHTML = `
          <span class="qty">${it.qty}</span>
          <span class="name">${it.name}</span>
          <span class="note">${it.note || ""}</span>
          <button class="btn btn-ghost sm" data-act="edit">✎</button>
          <button class="btn btn-ghost sm" data-act="del">🗑</button>
        `;
        zones[z].appendChild(li);
      }
    }
  }

  function boardClicks() {
    el.board.addEventListener("click", async (e) => {
      const li = e.target.closest(".item");
      const btn = e.target.closest("button");
      if (!li || !btn) return;
      const item = await DB.getItem(li.dataset.id);
      if (!item) return;
      if (btn.dataset.act === "del") {
        await DB.deleteItem(item.id);
        await renderBoard();
      } else if (btn.dataset.act === "edit") {
        const p1 = await prompt("Bezeichnung:", item.name);
        if (p1.result !== "ok") return;
        const p2 = await prompt("Menge:", String(item.qty));
        if (p2.result !== "ok") return;
        const p3 = await prompt("Notiz:", item.note || "");
        if (p3.result !== "ok") return;
        item.name = U.sanitize(p1.value);
        item.qty = Math.max(0, parseInt(p2.value || "0", 10) || 0);
        item.note = U.sanitize(p3.value);
        await DB.putItem(item);
        await renderBoard();
      }
    });
  }

  async function message(text) {
    el.msgText.textContent = text;
    await el.dlgMsg.showModal();
    return "ok";
  }
  async function confirm(text) {
    U.$("p", el.dlgConfirm).textContent = text;
    return await el.dlgConfirm.showModal();
  }
  async function prompt(label, defVal = "") {
    el.promptLabel.textContent = label;
    el.promptInput.value = defVal;
    const res = await el.dlgPrompt.showModal();
    return { result: res, value: el.promptInput.value };
  }

  function initForm() {
    el.dateDoc.value = U.todayStr();
    el.btnSaveOnly.addEventListener("click", (e) => handleSubmit(e, false));
    el.formInbound.addEventListener("submit", (e) => handleSubmit(e, true));
  }

  function initSearch() {
    el.btnSearch.addEventListener("click", search);
    el.quickSearch.addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
  }

  function initLists() {
    listClickHandler(el.listOhne, true);
    listClickHandler(el.listMit, false);
  }

  async function addBin() {
    const v = await prompt("Neuen Lagerplatz-Code eingeben (z. B. P-R2 1-1):", "");
    if (v.result !== "ok" || !v.value.trim()) return;
    const code = v.value.trim();
    await DB.putItem({ id: U.uuid(), name: code, zone: "Lagerplatz", qty: 0, note: "Platz" });
    await renderBoard();
  }

  // Public
  return {
    setRole, refreshLists, bumpSyncBadge, initForm, initSearch, initLists,
    dndInit, renderBoard, boardClicks, addBin,
    message, confirm, prompt, note
  };
})();

/* ---------- Admin ---------- */
const Admin = (() => {
  const btnLogin = document.getElementById("btnAdminLogin");
  const btnSetPin = document.getElementById("btnSetPin");
  const toggleHome = document.getElementById("toggleHomeLock");
  const toggleOverride = document.getElementById("toggleOverride");

  async function loadToggles() {
    toggleHome.checked = !!(await DB.getSetting("home_lock", false));
    toggleOverride.checked = !!(await DB.getSetting("override", false));
  }
  toggleHome.addEventListener("change", async () => {
    if (!App.isAdmin()) { toggleHome.checked = !toggleHome.checked; return; }
    await DB.setSetting("home_lock", toggleHome.checked);
  });
  toggleOverride.addEventListener("change", async () => {
    if (!App.isAdmin()) { toggleOverride.checked = !toggleOverride.checked; return; }
    await DB.setSetting("override", toggleOverride.checked);
  });

  btnSetPin.addEventListener("click", async () => {
    const p1 = await UI.prompt("Neue Admin-PIN:", "");
    if (p1.result !== "ok" || !p1.value.trim()) return;
    const p2 = await UI.prompt("PIN wiederholen:", "");
    if (p2.result !== "ok") return;
    if (p1.value !== p2.value) { await UI.message("PINs stimmen nicht überein."); return; }
    const hash = await U.sha256(new TextEncoder().encode(p1.value));
    localStorage.setItem("admin_pin_hash", hash);
    await UI.message("PIN gesetzt.");
  });

  btnLogin.addEventListener("click", async () => {
    const pin = await UI.prompt("Admin-PIN:", "");
    if (pin.result !== "ok") return;
    const hash = await U.sha256(new TextEncoder().encode(pin.value));
    const stored = localStorage.getItem("admin_pin_hash");
    if (stored && stored === hash) {
      App.setAdmin(true);
      UI.setRole(true);
      await UI.message("Erfolgreich als Admin angemeldet.");
    } else {
      await UI.message("PIN falsch.");
    }
  });

  return { loadToggles };
})();

/* ---------- Cart & Exports ---------- */
const Cart = (() => {
  async function add(name, qty, note) {
    const items = await DB.getCartAll();
    const same = items.find(i => i.name === name && (i.note || "") === (note || ""));
    if (same) {
      same.qty += qty;
      await DB.putCart(same);
    } else {
      await DB.putCart({ id: U.uuid(), name, qty, note });
    }
  }

  async function render() {
    const items = await DB.getCartAll();
    const tb = document.querySelector("#cartTable tbody");
    tb.innerHTML = "";
    for (const it of items) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td contenteditable="true" data-id="${it.id}" data-field="qty">${it.qty}</td>
        <td contenteditable="true" data-id="${it.id}" data-field="name">${it.name}</td>
        <td contenteditable="true" data-id="${it.id}" data-field="note">${it.note || ""}</td>
        <td><button class="btn btn-ghost sm" data-act="del" data-id="${it.id}">🗑</button></td>`;
      tb.appendChild(tr);
    }
  }

  async function onTableClick(e) {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.act === "del") {
      await DB.delCart(btn.dataset.id);
      await render();
    }
  }
  async function onTableInput(e) {
    const td = e.target.closest("[contenteditable]");
    if (!td) return;
    const id = td.dataset.id;
    const field = td.dataset.field;
    const items = await DB.getCartAll();
    const it = items.find(x => x.id === id);
    if (!it) return;
    const val = td.textContent.trim();
    if (field === "qty") it.qty = Math.max(0, parseInt(val || "0", 10) || 0);
    else it[field] = U.sanitize(val);
    await DB.putCart(it);
  }

  async function exportCSV() {
    const items = await DB.getCartAll();
    const rows = [["Menge", "Bezeichnung", "Notiz"], ...items.map(i => [i.qty, i.name, i.note || ""])];
    const csv = "\ufeff" + rows.map(r => r.map(U.csvEscape).join(";")).join("\n"); // UTF-8 BOM + ;
    U.download(`korb-${U.todayStr()}.csv`, "text/csv;charset=utf-8", csv);
  }

  async function exportPDF() {
    const items = await DB.getCartAll();
    const w = window.open("", "_blank", "noopener,noreferrer");
    if (!w) return;
    w.document.write(`
      <html><head><meta charset="utf-8"><title>Korb ${U.todayStr()}</title>
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;margin:20px}
        h1{font-size:18px}
        table{width:100%;border-collapse:collapse}
        th,td{border:1px solid #ccc;padding:8px;text-align:left}
        th{background:#f2f2f2}
      </style></head><body>
      <h1>Einkaufsliste / Korb – ${U.todayStr()}</h1>
      <table><thead><tr><th>Menge</th><th>Bezeichnung</th><th>Notiz</th></tr></thead><tbody>
      ${items.map(i => `<tr><td>${i.qty}</td><td>${i.name}</td><td>${i.note || ""}</td></tr>`).join("")}
      </tbody></table>
      <script>window.onload=()=>window.print()</script>
      </body></html>`);
    w.document.close();
  }

  return { add, render, exportCSV, exportPDF, onTableClick, onTableInput };
})();

/* ---------- App ---------- */
const App = (() => {
  let admin = false;
  const uid_key = "lv_user_id";

  function userId() {
    let id = localStorage.getItem(uid_key);
    if (!id) { id = U.uuid(); localStorage.setItem(uid_key, id); }
    return id;
  }
  function isAdmin() { return admin; }
  function setAdmin(v) { admin = !!v; }

  async function boot() {
    // UI wiring
    UI.setRole(false);
    UI.initForm();
    UI.initSearch();
    UI.initLists();
    UI.dndInit();
    UI.boardClicks();
    await Admin.loadToggles();

    // Actions
    document.getElementById("btnAddBin").addEventListener("click", UI.addBin);
    document.getElementById("btnExportCSV").addEventListener("click", Cart.exportCSV);
    document.getElementById("btnExportPDF").addEventListener("click", Cart.exportPDF);
    document.getElementById("btnClearCart").addEventListener("click", async () => { await DB.clearCart(); await Cart.render(); });
    document.querySelector("#cartTable").addEventListener("click", Cart.onTableClick);
    document.querySelector("#cartTable").addEventListener("input", Cart.onTableInput);

    // Lists
    await UI.refreshLists();
    await UI.renderBoard();
    await Cart.render();
    UI.bumpSyncBadge();
    // Online state
    (function setOnline() {
      const online = navigator.onLine;
      const el = document.getElementById("onlineBadge");
      el.textContent = online ? "Online" : "Offline";
      el.className = `badge ${online ? "badge-ok" : "badge-warn"}`;
    })();

    // Simple barcode via camera is out of scope; the 🎯 button just focuses LS input for now
    document.getElementById("btnScan").addEventListener("click", () => {
      document.getElementById("lsnr").focus();
    });

    // Accessibility: prevent long-press text selection in DnD zone (inputs remain normal)
    U.$$(".noselect").forEach(n => {
      n.addEventListener("mousedown", (e) => {
        if (!e.target.matches("input,textarea,[contenteditable]")) e.preventDefault();
      });
      n.addEventListener("touchstart", (e) => {
        if (!e.target.matches("input,textarea,[contenteditable]")) e.preventDefault();
      }, { passive: false });
    });

    // Seed sample board items if empty (no demo content saved to disk; only for first run)
    const any = (await DB.listItemsByZone("Wareneingang")).length
             + (await DB.listItemsByZone("Bestände")).length
             + (await DB.listItemsByZone("Lagerplatz")).length;
    if (!any) {
      await DB.putItem({ id: U.uuid(), name: "57-90-12 Untergestell", zone: "Wareneingang", qty: 20, note: "" });
      await DB.putItem({ id: U.uuid(), name: "61-91-112 Rückenteil", zone: "Bestände", qty: 50, note: "" });
      await DB.putItem({ id: U.uuid(), name: "P-R2 1-1", zone: "Lagerplatz", qty: 0, note: "Platz" });
      await UI.renderBoard();
    }
  }

  return { boot, userId, isAdmin, setAdmin };
})();

// Init
window.addEventListener("DOMContentLoaded", App.boot);
