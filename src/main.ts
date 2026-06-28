import "./style.css";
import "./metrics.css";
import type { DownloadItem, Settings } from "../electron/types";

type Filter = "all" | "active" | "completed" | "errors";
let state: { downloads: DownloadItem[]; settings: Settings } = { downloads: [], settings: {} as Settings };
let filter: Filter = "all";
let draggedId: string | null = null;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="titlebar">
    <div class="brand"><span class="logo">N</span><span>NexoDescargas</span></div>
    <div class="window-drag"></div>
  </header>
  <div class="shell">
    <aside>
      <button class="nav active" data-filter="all"><span>⌁</span> Todas <b id="all-count">0</b></button>
      <button class="nav" data-filter="active"><span>↓</span> Activas <b id="active-count">0</b></button>
      <button class="nav" data-filter="completed"><span>✓</span> Terminadas</button>
      <button class="nav" data-filter="errors"><span>!</span> Con errores</button>
      <div class="spacer"></div>
      <button class="nav" id="settings-btn"><span>⚙</span> Preferencias</button>
      <div class="hosts"><small>SITIOS COMPATIBLES</small><div>Marketcat</div><div>RapidShare</div><div>LolaUp</div><div>Solred</div></div>
    </aside>
    <main>
      <section class="hero">
        <div>
          <h1>Tus descargas, sin enredos.</h1>
          <p>Pega uno o varios enlaces. Nexo se ocupa de resolverlos, ordenarlos y reanudarlos.</p>
        </div>
        <button class="ghost" id="clear-btn">Limpiar terminadas</button>
      </section>
      <section class="add-card">
        <textarea id="links" placeholder="Pega aquí los enlaces, uno por línea…"></textarea>
        <div class="add-bottom">
          <span id="link-hint">Detectaremos automáticamente el sitio.</span>
          <button class="primary" id="add-btn">＋ Añadir a la cola</button>
        </div>
      </section>
      <section class="toolbar">
        <div><strong id="section-title">Todas las descargas</strong><span id="summary"></span></div>
        <label>Buscar <input id="search" type="search" placeholder="Nombre o sitio"></label>
      </section>
      <section id="list" class="list"></section>
    </main>
  </div>
  <dialog id="settings-dialog">
    <form method="dialog">
      <div class="dialog-head"><div><h2>Preferencias</h2><p>Ajusta el comportamiento del motor.</p></div><button class="icon">×</button></div>
      <label class="field">Carpeta de descargas<div class="row"><input id="directory" readonly><button type="button" id="browse">Elegir</button></div></label>
      <div class="two">
        <label class="field">Descargas simultáneas<input id="concurrent" type="number" min="1" max="8"></label>
        <label class="field">Límite de velocidad (KB/s)<input id="speed-limit" type="number" min="0"><small>0 significa sin límite</small></label>
      </div>
      <label class="check"><input id="autostart" type="checkbox"> Iniciar automáticamente al añadir</label>
      <div class="dialog-actions"><button value="cancel">Cancelar</button><button value="default" class="primary" id="save-settings">Guardar cambios</button></div>
    </form>
  </dialog>
  <div id="toast"></div>
`;

const formatBytes = (bytes = 0): string => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
};

const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "Calculando…";
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours} h${remainingMinutes ? ` ${remainingMinutes} min` : ""}`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days} d${remainingHours ? ` ${remainingHours} h` : ""}`;
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]!);

function statusLabel(item: DownloadItem): string {
  if (item.status === "retrying") {
    const seconds = Math.max(1, Math.ceil(((item.retryAt || Date.now()) - Date.now()) / 1000));
    return `Reintentando en ${seconds} s`;
  }
  const labels: Record<string, string> = {
    checking: "Consultando nombre y tamaño…", queued: "En cola", resolving: "Preparando descarga…",
    recovering: "Recuperando punto de reanudación…", downloading: "Descargando",
    paused: "En pausa", completed: "Completada", error: "Error", cancelled: "Cancelada"
  };
  return labels[item.status] || item.status;
}

function render(): void {
  const search = (document.querySelector<HTMLInputElement>("#search")?.value || "").toLowerCase();
  const canReorder = filter === "all" && !search;
  let items = state.downloads;
  if (filter === "active") items = items.filter(item => ["queued", "resolving", "downloading", "paused"].includes(item.status));
  if (filter === "completed") items = items.filter(item => item.status === "completed");
  if (filter === "errors") items = items.filter(item => ["error", "retrying"].includes(item.status));
  if (search) items = items.filter(item => `${item.name} ${item.host}`.toLowerCase().includes(search));
  const active = state.downloads.filter(item => ["resolving", "recovering", "downloading"].includes(item.status));
  const knownItems = state.downloads.filter(item => item.totalBytes);
  const totalBytes = knownItems.reduce((sum, item) => sum + (item.totalBytes || 0), 0);
  const downloadedBytes = knownItems.reduce(
    (sum, item) => sum + Math.min(item.downloadedBytes, item.totalBytes || item.downloadedBytes),
    0
  );
  const totalSpeed = active.reduce((sum, item) => sum + item.speed, 0);
  const recoveryBytes = state.downloads.reduce((sum, item) => sum + (item.recoveryBytesRemaining || 0), 0);
  const remainingBytes = Math.max(0, totalBytes - downloadedBytes) + recoveryBytes;
  const overallEta = totalBytes > 0 && remainingBytes === 0
    ? "Completado"
    : totalSpeed > 0 && remainingBytes > 0
      ? formatDuration(remainingBytes / totalSpeed)
      : "En espera";
  document.querySelector("#all-count")!.textContent = String(state.downloads.length);
  document.querySelector("#active-count")!.textContent = String(active.length);
  document.querySelector("#summary")!.innerHTML =
    `${state.downloads.length} elemento${state.downloads.length === 1 ? "" : "s"}` +
    ` · <b>${formatBytes(downloadedBytes)} descargados de ${formatBytes(totalBytes)}</b>` +
    (knownItems.length < state.downloads.length ? " + archivos consultándose" : "") +
    ` · ${formatBytes(totalSpeed)}/s` +
    ` · Tiempo restante: <b>${overallEta}</b>`;

  const list = document.querySelector("#list")!;
  if (!items.length) {
    list.innerHTML = `<div class="empty"><div>↓</div><h3>Aquí aparecerán tus descargas</h3><p>Pega enlaces arriba para comenzar.</p></div>`;
    return;
  }
  list.innerHTML = items.map(item => {
    const progress = item.totalBytes ? Math.min(100, item.downloadedBytes / item.totalBytes * 100) : 0;
    const canPause = ["downloading", "recovering", "resolving", "retrying"].includes(item.status);
    const canStart = ["paused", "queued"].includes(item.status);
    const action = canPause ? "pause" : canStart ? "start" : item.status === "error" ? "retry" : "";
    const actionText = action === "pause" ? "Ⅱ" : action === "retry" ? "↻" : "▶";
    const itemEta = ["downloading", "recovering"].includes(item.status)
      ? item.speed > 0 && item.totalBytes
        ? formatDuration((Math.max(0, item.totalBytes - item.downloadedBytes) + (item.recoveryBytesRemaining || 0)) / item.speed)
        : "Calculando…"
      : item.status === "completed" ? "0 s" : "";
    return `<article class="download ${item.status}" data-id="${item.id}" draggable="${canReorder}">
      <div class="drag-handle" title="${canReorder ? "Arrastra para cambiar el orden" : "Limpia la búsqueda para reordenar"}" aria-label="Cambiar posición">⋮⋮</div>
      <div class="file-icon">${escapeHtml(item.host.slice(0, 1).toUpperCase())}</div>
      <div class="file-main">
        <div class="file-top"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><span class="badge">${escapeHtml(item.host)}</span></div>
        <div class="meta"><span>${statusLabel(item)}</span><span>${formatBytes(item.downloadedBytes)}${item.totalBytes ? ` de ${formatBytes(item.totalBytes)}` : ""}</span>${item.speed ? `<span>${formatBytes(item.speed)}/s</span>` : ""}${itemEta ? `<span class="eta">⏱ ${itemEta} restantes</span>` : ""}</div>
        <div class="progress"><i style="width:${progress}%"></i></div>
        ${item.error ? `<div class="error-text">${escapeHtml(item.error)}</div>` : ""}
      </div>
      <div class="actions">
        ${item.status === "completed" && item.savePath ? `<button data-action="open" title="Mostrar en carpeta">⌕</button>` : ""}
        ${action ? `<button data-action="${action}" title="${action}">${actionText}</button>` : ""}
        <button data-action="remove" title="Quitar">×</button>
      </div>
    </article>`;
  }).join("");
}

function toast(message: string, bad = false): void {
  const element = document.querySelector<HTMLDivElement>("#toast")!;
  element.textContent = message;
  element.className = bad ? "show bad" : "show";
  setTimeout(() => element.className = "", 3200);
}

document.querySelector("#add-btn")!.addEventListener("click", async () => {
  const textarea = document.querySelector<HTMLTextAreaElement>("#links")!;
  if (!textarea.value.trim()) return toast("Pega al menos un enlace.", true);
  const result = await window.nexo.add(textarea.value);
  textarea.value = "";
  toast(`${result.added} enlace${result.added === 1 ? "" : "s"} añadido${result.added === 1 ? "" : "s"}${result.rejected.length ? ` · ${result.rejected.length} omitido(s)` : ""}`, result.added === 0);
});

document.querySelector("#list")!.addEventListener("click", async event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  const card = button?.closest<HTMLElement>("[data-id]");
  if (!button || !card) return;
  const item = state.downloads.find(value => value.id === card.dataset.id);
  if (!item) return;
  const action = button.dataset.action!;
  if (action === "open" && item.savePath) return void window.nexo.openPath(item.savePath);
  await window.nexo.action(action, item.id);
});

document.querySelector("#list")!.addEventListener("dragstart", event => {
  const card = (event.target as HTMLElement).closest<HTMLElement>(".download[draggable='true']");
  if (!card) return;
  draggedId = card.dataset.id || null;
  if (!draggedId) return;
  event.dataTransfer?.setData("text/plain", draggedId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  requestAnimationFrame(() => card.classList.add("dragging"));
});

document.querySelector("#list")!.addEventListener("dragover", event => {
  if (!draggedId) return;
  const card = (event.target as HTMLElement).closest<HTMLElement>(".download");
  if (!card || card.dataset.id === draggedId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".drop-before,.drop-after").forEach(node => node.classList.remove("drop-before", "drop-after"));
  const after = event.clientY > card.getBoundingClientRect().top + card.offsetHeight / 2;
  card.classList.add(after ? "drop-after" : "drop-before");
});

document.querySelector("#list")!.addEventListener("drop", async event => {
  const card = (event.target as HTMLElement).closest<HTMLElement>(".download");
  if (!draggedId || !card?.dataset.id || card.dataset.id === draggedId) return;
  event.preventDefault();
  const after = event.clientY > card.getBoundingClientRect().top + card.offsetHeight / 2;
  const sourceId = draggedId;
  draggedId = null;
  await window.nexo.action("reorder", sourceId, { targetId: card.dataset.id, after });
});

document.querySelector("#list")!.addEventListener("dragend", () => {
  draggedId = null;
  document.querySelectorAll(".dragging,.drop-before,.drop-after").forEach(node =>
    node.classList.remove("dragging", "drop-before", "drop-after")
  );
});

document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach(button => button.addEventListener("click", () => {
  filter = button.dataset.filter as Filter;
  document.querySelectorAll(".nav").forEach(node => node.classList.remove("active"));
  button.classList.add("active");
  render();
}));
document.querySelector("#search")!.addEventListener("input", render);
document.querySelector("#clear-btn")!.addEventListener("click", () => window.nexo.action("clearCompleted"));

const dialog = document.querySelector<HTMLDialogElement>("#settings-dialog")!;
document.querySelector("#settings-btn")!.addEventListener("click", () => {
  if (!state.settings?.downloadDirectory) {
    toast("La configuración todavía se está cargando.", true);
    return;
  }
  (document.querySelector("#directory") as HTMLInputElement).value = state.settings.downloadDirectory;
  (document.querySelector("#concurrent") as HTMLInputElement).value = String(state.settings.concurrentDownloads);
  (document.querySelector("#speed-limit") as HTMLInputElement).value = String(state.settings.speedLimitKbps);
  (document.querySelector("#autostart") as HTMLInputElement).checked = state.settings.startAutomatically;
  dialog.showModal();
});
document.querySelector("#browse")!.addEventListener("click", async () => {
  const directory = await window.nexo.chooseDirectory();
  if (directory) (document.querySelector("#directory") as HTMLInputElement).value = directory;
});
document.querySelector("#save-settings")!.addEventListener("click", async () => {
  await window.nexo.updateSettings({
    downloadDirectory: (document.querySelector("#directory") as HTMLInputElement).value,
    concurrentDownloads: Number((document.querySelector("#concurrent") as HTMLInputElement).value),
    speedLimitKbps: Number((document.querySelector("#speed-limit") as HTMLInputElement).value),
    startAutomatically: (document.querySelector("#autostart") as HTMLInputElement).checked
  });
  toast("Preferencias guardadas.");
});

window.nexo.onState(next => { state = next; render(); });
state = await window.nexo.getState();
render();
