import { describe, expect, it } from "vitest";
import { resolverInternals, supportsUrl } from "./resolvers.js";

describe("resolvers", () => {
  it("reconoce únicamente los cuatro hosts compatibles", () => {
    expect(supportsUrl("https://lolaup.com/abc/file")).toBe(true);
    expect(supportsUrl("https://drive.marketcat.io/drive/s/abc")).toBe(true);
    expect(supportsUrl("https://example.com/file")).toBe(false);
  });

  it("extrae bootstrapData aunque contenga objetos anidados", () => {
    const html = `<script>window.bootstrapData = {"loaders":{"shareableLinkPage":{"link":{"hash":"abc"}}}};</script>`;
    expect(resolverInternals.extractBootstrap(html).loaders.shareableLinkPage.link.hash).toBe("abc");
  });

  it("limpia caracteres inválidos de Windows", () => {
    expect(resolverInternals.cleanName('a:b?.rar')).toBe("a_b_.rar");
  });
});
