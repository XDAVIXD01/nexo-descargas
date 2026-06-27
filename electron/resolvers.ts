import * as cheerio from "cheerio";
import type { ResolvedLink } from "./types.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36";

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
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "descarga";
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
    const host = new URL(raw).hostname.toLowerCase();
    return ["drive.marketcat.io", "rapidshare.co", "www.rapidshare.co", "lolaup.com", "www.lolaup.com", "solred.app", "www.solred.app"].includes(host);
  } catch {
    return false;
  }
}

async function resolveLolaUp(sourceUrl: string): Promise<ResolvedLink> {
  const { html, finalUrl } = await getHtml(sourceUrl);
  const $ = cheerio.load(html);
  const direct = $("a.download-link").attr("href");
  if (!direct) throw new Error("LolaUp no publicó un enlace descargable");
  const label = $("a.download-link").text();
  const sizeMatch = label.match(/\(([\d.]+)\s*(KB|MB|GB|TB)\)/i);
  const factors: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return {
    sourceUrl,
    directUrl: new URL(direct, finalUrl).href,
    fileName: titleName(html),
    size: sizeMatch ? Number(sizeMatch[1]) * factors[sizeMatch[2].toUpperCase()] : undefined,
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
  const factors: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return {
    sourceUrl,
    directUrl: new URL(direct, finalUrl).href,
    fileName: cleanName(detailsDom(".originalFilename").first().text() || $("title").text().replace(/\s+-\s+Solred.*$/i, "")),
    size: sizeMatch ? Number(sizeMatch[1]) * factors[sizeMatch[2].toUpperCase()] : undefined,
    host: "Solred",
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
  const host = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
  if (host === "lolaup.com") return resolveLolaUp(sourceUrl);
  if (host === "solred.app") return resolveSolred(sourceUrl);
  if (host === "rapidshare.co") return resolveRapidShare(sourceUrl);
  if (host === "drive.marketcat.io") return resolveMarketcat(sourceUrl);
  throw new Error(`Host no compatible: ${host}`);
}

export const resolverInternals = { extractBootstrap, cleanName };
