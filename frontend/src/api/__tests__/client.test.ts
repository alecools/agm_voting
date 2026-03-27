import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../tests/msw/server";
import { apiFetch, apiFetchVoid } from "../client";

const BASE = "http://localhost:8000";

describe("apiFetch", () => {
  // --- Happy path ---

  it("returns parsed JSON on 200", async () => {
    server.use(
      http.get(`${BASE}/api/test-endpoint`, () =>
        HttpResponse.json({ ok: true })
      )
    );
    const result = await apiFetch<{ ok: boolean }>("/api/test-endpoint");
    expect(result).toEqual({ ok: true });
  });

  it("sends FormData without Content-Type header (lets browser set boundary)", async () => {
    let contentType: string | null = null;
    server.use(
      http.post(`${BASE}/api/test-upload`, ({ request }) => {
        contentType = request.headers.get("content-type");
        return HttpResponse.json({ uploaded: true });
      })
    );
    const formData = new FormData();
    formData.append("file", new File(["data"], "test.csv"));
    await apiFetch("/api/test-upload", { method: "POST", body: formData });
    // Browser sets multipart/form-data boundary automatically — Content-Type
    // should NOT be overridden to application/json by apiFetch.
    expect(contentType).not.toBe("application/json");
  });

  // --- State / precondition errors ---

  it("throws on non-ok response with status code in message", async () => {
    server.use(
      http.get(`${BASE}/api/test-error`, () =>
        HttpResponse.json({ detail: "not found" }, { status: 404 })
      )
    );
    await expect(apiFetch("/api/test-error")).rejects.toThrow("404");
  });

  it("throws on 500 response", async () => {
    server.use(
      http.get(`${BASE}/api/test-500`, () =>
        new HttpResponse("Internal Server Error", { status: 500 })
      )
    );
    await expect(apiFetch("/api/test-500")).rejects.toThrow("500");
  });
});

describe("apiFetchVoid", () => {
  // --- Happy path ---

  it("resolves to undefined on 204 no-content response", async () => {
    server.use(
      http.delete(`${BASE}/api/test-delete`, () =>
        new HttpResponse(null, { status: 204 })
      )
    );
    const result = await apiFetchVoid("/api/test-delete", { method: "DELETE" });
    expect(result).toBeUndefined();
  });

  it("resolves to undefined on 200 response (e.g. legacy endpoints)", async () => {
    server.use(
      http.delete(`${BASE}/api/test-delete-200`, () =>
        new HttpResponse(null, { status: 200 })
      )
    );
    const result = await apiFetchVoid("/api/test-delete-200", { method: "DELETE" });
    expect(result).toBeUndefined();
  });

  it("sends FormData without overriding Content-Type", async () => {
    let contentType: string | null = null;
    server.use(
      http.post(`${BASE}/api/test-void-upload`, ({ request }) => {
        contentType = request.headers.get("content-type");
        return new HttpResponse(null, { status: 204 });
      })
    );
    const formData = new FormData();
    formData.append("file", new File(["data"], "test.csv"));
    await apiFetchVoid("/api/test-void-upload", { method: "POST", body: formData });
    expect(contentType).not.toBe("application/json");
  });

  // --- State / precondition errors ---

  it("throws on 409 conflict response", async () => {
    server.use(
      http.delete(`${BASE}/api/test-delete-conflict`, () =>
        HttpResponse.json({ detail: "Conflict" }, { status: 409 })
      )
    );
    await expect(
      apiFetchVoid("/api/test-delete-conflict", { method: "DELETE" })
    ).rejects.toThrow("409");
  });

  it("throws on 403 forbidden response", async () => {
    server.use(
      http.delete(`${BASE}/api/test-delete-403`, () =>
        new HttpResponse("Forbidden", { status: 403 })
      )
    );
    await expect(
      apiFetchVoid("/api/test-delete-403", { method: "DELETE" })
    ).rejects.toThrow("403");
  });

  it("throws on 500 server error", async () => {
    server.use(
      http.delete(`${BASE}/api/test-delete-500`, () =>
        new HttpResponse("Server Error", { status: 500 })
      )
    );
    await expect(
      apiFetchVoid("/api/test-delete-500", { method: "DELETE" })
    ).rejects.toThrow("500");
  });
});
