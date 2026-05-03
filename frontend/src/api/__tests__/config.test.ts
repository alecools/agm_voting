import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../tests/msw/server";
import {
  getSmtpConfig,
  updateSmtpConfig,
  testSmtpConfig,
  getSmtpStatus,
} from "../config";

const BASE = "http://localhost";

describe("SMTP config API", () => {
  it("getSmtpConfig fetches and returns smtp config", async () => {
    const fixture = {
      smtp_host: "smtp.example.com",
      smtp_port: 587,
      smtp_username: "user",
      smtp_from_email: "from@example.com",
      password_is_set: true,
    };
    server.use(
      http.get(`${BASE}/api/admin/config/smtp`, () => HttpResponse.json(fixture))
    );
    const result = await getSmtpConfig();
    expect(result.smtp_host).toBe("smtp.example.com");
    expect(result.password_is_set).toBe(true);
  });

  it("updateSmtpConfig PUTs data and returns updated config", async () => {
    const updated = {
      smtp_host: "new.smtp.com",
      smtp_port: 465,
      smtp_username: "newuser",
      smtp_from_email: "new@example.com",
      password_is_set: true,
    };
    server.use(
      http.put(`${BASE}/api/admin/config/smtp`, () => HttpResponse.json(updated))
    );
    const result = await updateSmtpConfig({
      smtp_host: "new.smtp.com",
      smtp_port: 465,
      smtp_username: "newuser",
      smtp_from_email: "new@example.com",
      smtp_password: "secret",
    });
    expect(result.smtp_host).toBe("new.smtp.com");
    expect(result.smtp_port).toBe(465);
  });

  it("testSmtpConfig POSTs and returns ok", async () => {
    server.use(
      http.post(`${BASE}/api/admin/config/smtp/test`, () => HttpResponse.json({ ok: true }))
    );
    const result = await testSmtpConfig("test@example.com");
    expect(result.ok).toBe(true);
  });

  it("testSmtpConfig sends X-Requested-With header (CSRF protection)", async () => {
    let xRequestedWith: string | null = null;
    server.use(
      http.post(`${BASE}/api/admin/config/smtp/test`, ({ request }) => {
        xRequestedWith = request.headers.get("x-requested-with");
        return HttpResponse.json({ ok: true });
      })
    );
    await testSmtpConfig("csrf-check@example.com");
    expect(xRequestedWith).toBe("XMLHttpRequest");
  });

  it("getSmtpStatus returns configured status", async () => {
    server.use(
      http.get(`${BASE}/api/admin/config/smtp/status`, () =>
        HttpResponse.json({ configured: true })
      )
    );
    const result = await getSmtpStatus();
    expect(result.configured).toBe(true);
  });

  it("getSmtpStatus returns false when unconfigured", async () => {
    server.use(
      http.get(`${BASE}/api/admin/config/smtp/status`, () =>
        HttpResponse.json({ configured: false })
      )
    );
    const result = await getSmtpStatus();
    expect(result.configured).toBe(false);
  });

  it("updateSmtpConfig without password omits smtp_password", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.put(`${BASE}/api/admin/config/smtp`, async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_username: "user",
          smtp_from_email: "from@example.com",
          password_is_set: false,
        });
      })
    );
    await updateSmtpConfig({
      smtp_host: "smtp.example.com",
      smtp_port: 587,
      smtp_username: "user",
      smtp_from_email: "from@example.com",
    });
    expect(capturedBody).not.toBeNull();
    expect((capturedBody! as Record<string, unknown>).smtp_password).toBeUndefined();
  });
});
