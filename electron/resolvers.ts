import * as cheerio from "cheerio";
import type { ResolvedLink } from "./types.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36";
const SIZE_FACTORS: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
const SUPPORTED_HOSTS = [
  "drive.marketcat.io",
  "rapidshare.co",
  "www.rapidshare.co",
  "lolaup.com",
  "www.lolaup.com",
  "solred.app",
  "www.solred.app",
  "usersdrive.com",
  "www.usersdrive.com",
  "megaup.net",
  "www.megaup.net",
  "pixeldrain.com",
  "www.pixeldrain.com",
  "fireload.com",
  "www.fireload.com",
  "rootz.so",
  "www.rootz.so"
];

export class BrowserVerificationRequiredError extends Error {
  resolved?: ResolvedLink;

  constructor(host: string) {
    super(`${host} requiere verificación humana/captcha antes de entregar el enlace directo`);
  }
}

async function getHtml(url: string): Promise<{ html: string; finalUrl: string; cookie: string }> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" }
  });
  if (!response.ok) throw new Error(`El servidor respondió ${response.status}`);
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
  const cookie = setCookies.map(value => value.split(";")[0]).filter(Boolean).join("; ");
  return { html: await response.text(), finalUrl: response.url, cookie };
}

function cleanName(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "descarga";
}

function parseSize(text: string): number | undefined {
  const bytesMatch = text.match(/\b(\d{6,})\b/);
  if (bytesMatch) return Number(bytesMatch[1]) || undefined;
  const sizeMatch = text.match(/([\d.]+)\s*(KB|MB|GB|TB)\b/i);
  return sizeMatch ? Math.round(Number(sizeMatch[1]) * SIZE_FACTORS[sizeMatch[2].toUpperCase()]) : undefined;
}

export function unwrapUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    for (const key of ["s", "url", "u", "target"]) {
      const value = parsed.searchParams.get(key);
      if (value?.startsWith("http")) return unwrapUrl(value);
    }
  } catch {}
  return raw;
}

function titleName(html: string): string {
  const $ = cheerio.load(html);
  const title = $("meta[property='og:title']").attr("content") || $("title").text();
  return cleanName(
    title
      .replace(/\s+-\s+MarketCat.*$/i, "")
      .replace(/^LolaUp\s*[-—]\s*(?:Download\s*[-—]\s*)?/i, "")
  );
}

export function supportsUrl(raw: string): boolean {
  try {
    const host = new URL(unwrapUrl(raw)).hostname.toLowerCase();
    return SUPPORTED_HOSTS.includes(host);
  } catch {
    return false;
  }
}

export function extractSupportedUrls(rawText: string): string[] {
  const urls = rawText.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  const cleaned = urls.map(value => unwrapUrl(value).replace(/[),.;\]]+$/g, ""));
  return [...new Set(cleaned)].filter(supportsUrl);
}

async function resolveLolaUp(sourceUrl: string): Promise<ResolvedLink> {
  const { html, finalUrl } = await getHtml(sourceUrl);
  const $ = cheerio.load(html);
  const direct = $("a.download-link").attr("href");
  if (!direct) throw new Error("LolaUp no publicó un enlace descargable");
  const label = $("a.download-link").text();
  const sizeMatch = label.match(/\(([\d.]+)\s*(KB|MB|GB|TB)\)/i);
  return {
    sourceUrl,
    directUrl: new URL(direct, finalUrl).href,
    fileName: titleName(html),
    size: sizeMatch ? Number(sizeMatch[1]) * SIZE_FACTORS[sizeMatch[2].toUpperCase()] : undefined,
    host: "LolaUp",
    headers: { referer: finalUrl, "user-agent": USER_AGENT }
  };
}

async function resolveSolred(sourceUrl: string): Promise<ResolvedLink> {
  const { html, finalUrl, cookie } = await getHtml(sourceUrl);
  const $ = cheerio.load(html);
  let detailsHtml = html;
  if (!$("button.download-file").length) {
    const fileId = html.match(/showFile\(\s*(\d+)/)?.[1];
    if (!fileId) throw new Error("Solred no publicó el identificador del archivo");
    const detailResponse = await fetch(`${new URL(finalUrl).origin}/account/ajax/file_details_2`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        referer: finalUrl,
        cookie,
        "user-agent": USER_AGENT,
        accept: "application/json"
      },
      body: new URLSearchParams({ u: fileId, isfront: "true" })
    });
    if (!detailResponse.ok) throw new Error(`Solred respondió ${detailResponse.status}`);
    const details = (await detailResponse.json()) as { html?: string };
    detailsHtml = details.html || "";
  }
  const detailsDom = cheerio.load(detailsHtml);
  const onclick = detailsDom("button.download-file").attr("onclick") || "";
  const direct = onclick.match(/window\.location\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (!direct) throw new Error("Solred no publicó un enlace descargable");
  const sizeText = detailsDom("button.download-file").text();
  const sizeMatch = sizeText.match(/\(([\d.]+)\s*(KB|MB|GB|TB)\)/i);
  return {
    sourceUrl,
    directUrl: new URL(direct, finalUrl).href,
    fileName: cleanName(detailsDom(".originalFilename").first().text() || $("title").text().replace(/\s+-\s+Solred.*$/i, "")),
    size: sizeMatch ? Number(sizeMatch[1]) * SIZE_FACTORS[sizeMatch[2].toUpperCase()] : undefined,
    host: "Solred",
    headers: { referer: finalUrl, "user-agent": USER_AGENT }
  };
}

async function resolvePixelDrain(sourceUrl: string): Promise<ResolvedLink> {
  const id = new URL(sourceUrl).pathname.split("/").filter(Boolean).pop();
  if (!id) throw new Error("PixelDrain no publicó el identificador del archivo");
  const response = await fetch(`https://pixeldrain.com/api/file/${encodeURIComponent(id)}/info`, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" }
  });
  if (!response.ok) throw new Error(`PixelDrain respondió ${response.status}`);
  const data = (await response.json()) as { success?: boolean; name?: string; size?: number; can_download?: boolean; message?: string };
  if (!data.success || data.can_download === false) throw new Error(data.message || "PixelDrain no permite descargar este archivo");
  return {
    sourceUrl,
    directUrl: `https://pixeldrain.com/api/file/${encodeURIComponent(id)}?download`,
    fileName: cleanName(data.name || id),
    size: Number(data.size) || undefined,
    host: "PixelDrain",
    headers: { referer: sourceUrl, "user-agent": USER_AGENT }
  };
}

async function resolveMegaUp(sourceUrl: string): Promise<ResolvedLink> {
  const { html, finalUrl, cookie } = await getHtml(sourceUrl);
  const $ = cheerio.load(html);
  const direct = $("a[href*='download.megaup.net']").attr("href") || html.match(/href=['"]([^'"]*download\.megaup\.net[^'"]+)['"]/)?.[1];
  const fileName = cleanName($(".download-page h2, h2").first().text() || $("title").text().replace(/\s+-\s+MegaUp.*$/i, ""));
  const size = parseSize($("table").text() || html);
  if (!direct) {
    throw Object.assign(new BrowserVerificationRequiredError("MegaUp"), {
      resolved: { sourceUrl, directUrl: finalUrl, fileName, size, host: "MegaUp" }
    });
  }
  const resolved = {
    sourceUrl,
    directUrl: new URL(direct, finalUrl).href,
    fileName,
    size,
    host: "MegaUp",
    headers: { referer: finalUrl, "user-agent": USER_AGENT, cookie }
  };
  const probe = await fetch(resolved.directUrl, {
    redirect: "follow",
    headers: { ...resolved.headers, range: "bytes=0-0" }
  });
  await probe.body?.cancel();
  if (probe.status === 403 || probe.status === 401 || probe.headers.get("content-type")?.includes("text/html")) {
    throw Object.assign(new BrowserVerificationRequiredError("MegaUp"), { resolved });
  }
  return resolved;
}

async function resolveUsersDrive(sourceUrl: string): Promise<ResolvedLink> {
  const { html, finalUrl } = await getHtml(sourceUrl);
  const $ = cheerio.load(html);
  const fileName = cleanName($(".download .name h4").first().text() || $("title").text().replace(/^Download\s+/i, ""));
  const size = parseSize($("#fr textarea").text() || $(".download .size").first().text() || html);
  throw Object.assign(new BrowserVerificationRequiredError("UsersDrive"), {
    resolved: { sourceUrl, directUrl: finalUrl, fileName, size, host: "UsersDrive" }
  });
}

async function resolveFireload(sourceUrl: string): Promise<ResolvedLink> {
  const { html, finalUrl } = await getHtml(sourceUrl);
  const $ = cheerio.load(html);
  const fileName = cleanName($(".file-item .name").first().text() || $("meta[property='og:title']").attr("content")?.replace(/\s+-\s+shared.*$/i, "") || titleName(html));
  const size = parseSize($(".item-size").first().text() || html);
  const direct = $("a[href*='/download/'], a[href*='download/view']").attr("href");
  if (!direct) {
    throw Object.assign(new BrowserVerificationRequiredError("Fireload"), {
      resolved: { sourceUrl, directUrl: finalUrl, fileName, size, host: "Fireload" }
    });
  }
  return {
    sourceUrl,
    directUrl: new URL(direct, finalUrl).href,
    fileName,
    size,
    host: "Fireload",
    headers: { referer: finalUrl, "user-agent": USER_AGENT }
  };
}

function extractRootzPageToken(html: string): string {
  const token =
    html.match(/pageToken\\":\\"([^\\"]+)/)?.[1] ||
    html.match(/pageToken":"([^"]+)/)?.[1];
  if (!token) throw new Error("Rootz no publicó el token de página");
  return token;
}

async function resolveRootz(sourceUrl: string): Promise<ResolvedLink> {
  const { html, finalUrl } = await getHtml(sourceUrl);
  const shortId = new URL(finalUrl).pathname.split("/").filter(Boolean).pop();
  if (!shortId) throw new Error("Rootz no publicó el identificador del archivo");
  const pageToken = extractRootzPageToken(html);
  const response = await fetch(`${new URL(finalUrl).origin}/api/files/download-by-short?shortId=${encodeURIComponent(shortId)}`, {
    headers: {
      accept: "application/json",
      referer: finalUrl,
      "user-agent": USER_AGENT,
      "x-page-token": pageToken
    }
  });
  if (!response.ok) throw new Error(`Rootz respondió ${response.status}`);
  const payload = (await response.json()) as {
    success?: boolean;
    error?: string;
    data?: {
      fileId?: string;
      fileName?: string;
      size?: number;
      downloadAllowed?: boolean;
      passwordProtected?: boolean;
      status?: string;
    };
  };
  const data = payload.data;
  if (!payload.success || !data) throw new Error(payload.error || "Rootz no devolvió metadatos");
  if (data.status && data.status !== "active") throw new Error(`Rootz reportó el archivo como ${data.status}`);
  if (data.passwordProtected) {
    throw Object.assign(new BrowserVerificationRequiredError("Rootz"), {
      resolved: {
        sourceUrl,
        directUrl: finalUrl,
        fileName: cleanName(data.fileName || titleName(html)),
        size: Number(data.size) || undefined,
        host: "Rootz"
      }
    });
  }
  if (!data.downloadAllowed) throw new Error("Rootz no permite descargar este archivo en este momento");
  if (!data.fileId) throw new Error("Rootz no devolvió el identificador interno del archivo");
  return {
    sourceUrl,
    directUrl: `${new URL(finalUrl).origin}/api/files/proxy-download/${encodeURIComponent(data.fileId)}`,
    fileName: cleanName(data.fileName || titleName(html)),
    size: Number(data.size) || undefined,
    host: "Rootz",
    headers: { referer: finalUrl, "user-agent": USER_AGENT }
  };
}

async function resolveRapidShare(sourceUrl: string): Promise<ResolvedLink> {
  const { html, finalUrl, cookie } = await getHtml(sourceUrl);
  const $ = cheerio.load(html);
  const id = $("a.download-btn").attr("data-id");
  const transfer = html.match(/transferIdentifier\s*:\s*["']([^"']+)["']/)?.[1];
  const lang = new URL(finalUrl).pathname.split("/").filter(Boolean)[0] || "en";
  if (!id || !transfer) throw new Error("RapidShare cambió su flujo de descarga");
  const requestUrl = `${new URL(finalUrl).origin}/${lang}/d/${transfer}/single/request`;
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      "x-csrf-token": $("meta[name='csrf-token']").attr("content") || "",
      referer: finalUrl,
      cookie,
      "user-agent": USER_AGENT,
      accept: "application/json"
    },
    body: new URLSearchParams({ id })
  });
  if (!response.ok) throw new Error(`RapidShare respondió ${response.status}`);
  const data = (await response.json()) as { download_link?: string; error?: string };
  if (!data.download_link) throw new Error(data.error || "RapidShare no devolvió un enlace");
  const responseCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie().map(value => value.split(";")[0]).filter(Boolean).join("; ")
    : "";
  const downloadCookie = [cookie, responseCookies].filter(Boolean).join("; ");
  const pageName = $(".file-title, .download-file-name, .file-name").first().text().trim();
  const name = cleanName(pageName || new URL(data.download_link).pathname.split("/").pop() || titleName(html));
  return {
    sourceUrl,
    directUrl: data.download_link,
    fileName: name,
    host: "RapidShare",
    headers: { referer: finalUrl, "user-agent": USER_AGENT, cookie: downloadCookie }
  };
}

function extractBootstrap(html: string): any {
  const marker = "window.bootstrapData";
  const markerIndex = html.indexOf(marker);
  const start = html.indexOf("{", markerIndex);
  if (markerIndex < 0 || start < 0) throw new Error("Marketcat no publicó metadatos");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error("Los metadatos de Marketcat están incompletos");
}

async function resolveMarketcat(sourceUrl: string): Promise<ResolvedLink> {
  const { html, finalUrl } = await getHtml(sourceUrl);
  const data = extractBootstrap(html);
  const link = data?.loaders?.shareableLinkPage?.link;
  const entry = link?.entry;
  if (!entry || !link?.allow_download) throw new Error("Este enlace de Marketcat no permite descargas");

  // BeDrive entrega el archivo desde este endpoint y conserva el hash compartido
  // como autorización. Se renueva al resolver el enlace antes de cada intento.
  const origin = new URL(finalUrl).origin;
  const directUrl =
    `${origin}/api/v1/file-entries/download/${encodeURIComponent(entry.hash)}` +
    `?shareable_link=${encodeURIComponent(link.id)}&password=null`;
  return {
    sourceUrl,
    directUrl,
    fileName: cleanName(entry.name),
    size: Number(entry.file_size) || undefined,
    host: "Marketcat",
    headers: { referer: finalUrl, "user-agent": USER_AGENT }
  };
}

export async function resolveLink(sourceUrl: string): Promise<ResolvedLink> {
  sourceUrl = unwrapUrl(sourceUrl);
  const host = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
  if (host === "usersdrive.com") return resolveUsersDrive(sourceUrl);
  if (host === "megaup.net") return resolveMegaUp(sourceUrl);
  if (host === "pixeldrain.com") return resolvePixelDrain(sourceUrl);
  if (host === "fireload.com") return resolveFireload(sourceUrl);
  if (host === "rootz.so") return resolveRootz(sourceUrl);
  if (host === "lolaup.com") return resolveLolaUp(sourceUrl);
  if (host === "solred.app") return resolveSolred(sourceUrl);
  if (host === "rapidshare.co") return resolveRapidShare(sourceUrl);
  if (host === "drive.marketcat.io") return resolveMarketcat(sourceUrl);
  throw new Error(`Host no compatible: ${host}`);
}

export const resolverInternals = { extractBootstrap, cleanName, parseSize, unwrapUrl, extractRootzPageToken };
