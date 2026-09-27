import { net } from "electron";

// Electron's network stack handles streamed responses independently of the
// Undici HTTP/1 parser used by Node fetch in the main process.
export const fetch = (url: string, options?: RequestInit): Promise<Response> => {
  const headers = new Headers(options?.headers);
  const referrer = headers.get("referer");
  if (referrer && new URL(referrer).origin !== new URL(url).origin) {
    // Chromium rejects a manually supplied cross-origin Referer header.
    headers.delete("referer");
  }
  return net.fetch(url, { ...options, headers, referrer: referrer || options?.referrer });
};
