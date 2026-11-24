import { BrowserWindow } from "electron";
import type { ResolvedLink } from "./types.js";

let pending: Promise<unknown> = Promise.resolve();

export function isGofile(url: string): boolean {
  return ["gofile.io", "www.gofile.io"].includes(new URL(url).hostname.toLowerCase());
}

// Run the site's own public browsing flow in an isolated renderer. Guest
// credentials remain in Electron's cookie store and are never written to URLs.
export function expandGofile(sourceUrl: string): Promise<ResolvedLink[]> {
  const task = pending.catch(() => undefined).then(() => readGofile(sourceUrl));
  pending = task;
  return task;
}

async function readGofile(sourceUrl: string): Promise<ResolvedLink[]> {
  const url = new URL(sourceUrl);
  const contentId = url.pathname.match(/^\/d\/([A-Za-z0-9-]+)\/?$/)?.[1];
  if (!contentId) throw new Error("GoFile: usa un enlace https://gofile.io/d/…");
  const selected = new URLSearchParams(url.hash.slice(1)).get("file");
  if (selected && !/^[A-Za-z0-9-]+$/.test(selected)) throw new Error("GoFile: archivo inválido");
  const window = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        await window.loadURL(`https://gofile.io/d/${contentId}`);
        const result = await window.webContents.executeJavaScript(`(async () => {
          try {
            const { accountsReady } = await import('/js/accounts/accountService.js');
            const { getActiveAccount } = await import('/js/accounts/accountStore.js');
            const { getFolder } = await import('/js/services/contents.js');
            await accountsReady;
            const account = getActiveAccount();
            if (!account) throw new Error('No se pudo iniciar la sesión de invitado de GoFile');
            const files = [];
            const visited = new Set();
            async function visit(id, depth = 0) {
              if (visited.has(id)) return;
              if (depth > 32 || visited.size >= 1000) throw new Error('GoFile: carpeta demasiado extensa');
              visited.add(id);
              for (let page = 1; page <= 1000; page++) {
                const { data, metadata } = await getFolder(account.token, id, { page, pageSize: 100 });
                if (data.canAccess === false) throw new Error('GoFile: el contenido requiere contraseña, es privado o ha caducado');
                if (data.type === 'file') { files.push(data); return; }
                for (const item of Object.values(data.children || {})) {
                  if (item.type === 'file') files.push(item);
                  else if (item.type === 'folder') await visit(item.id, depth + 1);
                }
                if (files.length > 10000) throw new Error('GoFile: demasiados archivos en una sola carpeta');
                if (!metadata?.hasNextPage && !(metadata?.totalPages > page)) return;
              }
              throw new Error('GoFile: demasiadas páginas');
            }
            await visit(${JSON.stringify(selected || contentId)});
            return { files: files.map(file => ({ id: file.id, name: file.name, size: file.size, link: file.link })) };
          } catch (error) {
            return { error: error.apiStatus || error.message || 'No se pudo consultar GoFile' };
          }
        })()`);
        if (result.error) throw new Error(`GoFile: ${result.error}`);
        if (!result.files?.length) throw new Error("GoFile: la carpeta no contiene archivos descargables");
        return result.files.map((file: { id: string; name: string; size: number; link: string }) => {
          const direct = new URL(file.link);
          if (direct.protocol !== "https:" || !direct.hostname.endsWith(".gofile.io")) {
            throw new Error("GoFile no entregó una dirección de descarga válida");
          }
          return {
            sourceUrl: `https://gofile.io/d/${contentId}#file=${encodeURIComponent(file.id)}`,
            directUrl: direct.href,
            fileName: file.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "descarga",
            size: Number(file.size) || undefined,
            host: "GoFile",
            headers: { referer: `https://gofile.io/d/${contentId}` }
          };
        });
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("GoFile tardó demasiado en responder. Vuelve a intentarlo.")), 90_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
    window.destroy();
  }
}
