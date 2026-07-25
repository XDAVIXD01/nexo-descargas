import { describe, expect, it } from "vitest";
import { extractSupportedUrls, resolverInternals, supportsUrl } from "./resolvers.js";

describe("resolvers", () => {
  it("reconoce los hosts compatibles", () => {
    expect(supportsUrl("https://lolaup.com/abc/file")).toBe(true);
    expect(supportsUrl("https://drive.marketcat.io/drive/s/abc")).toBe(true);
    expect(supportsUrl("https://usersdrive.com/ftyvzu5d3chm.html")).toBe(true);
    expect(supportsUrl("https://megaup.net/hash/file.rar")).toBe(true);
    expect(supportsUrl("https://pixeldrain.com/u/qyKansTK")).toBe(true);
    expect(supportsUrl("https://www.fireload.com/id/file.rar")).toBe(true);
    expect(supportsUrl("https://www.rootz.so/d/oJGHQ")).toBe(true);
    expect(supportsUrl("https://example.com/file")).toBe(false);
  });

  it("extrae enlaces reales desde wrappers ouo.io", () => {
    const text = "[https://pixeldrain.com/u/qyKansTK](http://ouo.io/qs/x?s=https://pixeldrain.com/u/qyKansTK)";
    expect(extractSupportedUrls(text)).toEqual(["https://pixeldrain.com/u/qyKansTK"]);
  });

  it("extrae bootstrapData aunque contenga objetos anidados", () => {
    const html = `<script>window.bootstrapData = {"loaders":{"shareableLinkPage":{"link":{"hash":"abc"}}}};</script>`;
    expect(resolverInternals.extractBootstrap(html).loaders.shareableLinkPage.link.hash).toBe("abc");
  });

  it("extrae el pageToken de Rootz desde la respuesta de Next.js", () => {
    const html = `<script>self.__next_f.push([1,"5:[\\"$\\",\\"$L1b\\",null,{\\"shortId\\":\\"oJGHQ\\",\\"pageToken\\":\\"abc.def\\"}]"])</script>`;
    expect(resolverInternals.extractRootzPageToken(html)).toBe("abc.def");
  });

  it("limpia caracteres inválidos de Windows", () => {
    expect(resolverInternals.cleanName('a:b?.rar')).toBe("a_b_.rar");
  });
});
