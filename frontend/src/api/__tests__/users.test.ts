import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../tests/msw/server";
import { listAdminUsers, inviteAdminUser, removeAdminUser } from "../users";

const BASE = "http://localhost";

const USER_1 = {
  id: "user-1",
  email: "admin1@example.com",
  created_at: "2026-01-01T00:00:00.000Z",
};

const USER_2 = {
  id: "user-2",
  email: "admin2@example.com",
  created_at: "2026-02-01T00:00:00.000Z",
};

describe("listAdminUsers", () => {
  // --- Happy path ---

  it("fetches and returns list of admin users", async () => {
    server.use(
      http.get(`${BASE}/api/admin/users`, () =>
        HttpResponse.json({ users: [USER_1, USER_2] })
      )
    );
    const result = await listAdminUsers();
    expect(result.users).toHaveLength(2);
    expect(result.users[0].id).toBe("user-1");
    expect(result.users[0].email).toBe("admin1@example.com");
    expect(result.users[1].id).toBe("user-2");
  });

  it("returns empty list when no users exist", async () => {
    server.use(
      http.get(`${BASE}/api/admin/users`, () =>
        HttpResponse.json({ users: [] })
      )
    );
    const result = await listAdminUsers();
    expect(result.users).toHaveLength(0);
  });

  it("sends X-Requested-With header", async () => {
    let xRequestedWith: string | null = null;
    server.use(
      http.get(`${BASE}/api/admin/users`, ({ request }) => {
        xRequestedWith = request.headers.get("x-requested-with");
        return HttpResponse.json({ users: [] });
      })
    );
    await listAdminUsers();
    expect(xRequestedWith).toBe("XMLHttpRequest");
  });

  // --- Error states ---

  it("throws on non-2xx response", async () => {
    server.use(
      http.get(`${BASE}/api/admin/users`, () =>
        HttpResponse.json({ detail: "Not configured" }, { status: 503 })
      )
    );
    await expect(listAdminUsers()).rejects.toThrow("HTTP 503");
  });
});

describe("inviteAdminUser", () => {
  // --- Happy path ---

  it("POSTs to invite endpoint and returns created user", async () => {
    const newUser = { id: "new-id", email: "newadmin@example.com", created_at: "2026-03-01T00:00:00.000Z" };
    server.use(
      http.post(`${BASE}/api/admin/users/invite`, () =>
        HttpResponse.json(newUser, { status: 201 })
      )
    );
    const result = await inviteAdminUser("newadmin@example.com");
    expect(result.id).toBe("new-id");
    expect(result.email).toBe("newadmin@example.com");
  });

  it("sends email in JSON body", async () => {
    let capturedBody: unknown = null;
    server.use(
      http.post(`${BASE}/api/admin/users/invite`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: "x", email: "a@b.com", created_at: "2026-01-01T00:00:00.000Z" }, { status: 201 });
      })
    );
    await inviteAdminUser("a@b.com");
    expect(capturedBody).toEqual({ email: "a@b.com" });
  });

  it("sends X-Requested-With header", async () => {
    let xRequestedWith: string | null = null;
    server.use(
      http.post(`${BASE}/api/admin/users/invite`, ({ request }) => {
        xRequestedWith = request.headers.get("x-requested-with");
        return HttpResponse.json({ id: "x", email: "a@b.com", created_at: "2026-01-01T00:00:00.000Z" }, { status: 201 });
      })
    );
    await inviteAdminUser("a@b.com");
    expect(xRequestedWith).toBe("XMLHttpRequest");
  });

  // --- Error states ---

  it("throws on 409 duplicate email", async () => {
    server.use(
      http.post(`${BASE}/api/admin/users/invite`, () =>
        HttpResponse.json({ detail: "A user with that email already exists." }, { status: 409 })
      )
    );
    await expect(inviteAdminUser("existing@example.com")).rejects.toThrow("HTTP 409");
  });

  it("throws on 503 not configured", async () => {
    server.use(
      http.post(`${BASE}/api/admin/users/invite`, () =>
        HttpResponse.json({ detail: "User management not configured" }, { status: 503 })
      )
    );
    await expect(inviteAdminUser("test@example.com")).rejects.toThrow("HTTP 503");
  });
});

describe("removeAdminUser", () => {
  // --- Happy path ---

  it("sends DELETE request and resolves on 204", async () => {
    server.use(
      http.delete(`${BASE}/api/admin/users/user-to-remove`, () =>
        new HttpResponse(null, { status: 204 })
      )
    );
    await expect(removeAdminUser("user-to-remove")).resolves.toBeUndefined();
  });

  it("sends DELETE to correct URL with user ID", async () => {
    let capturedUrl = "";
    server.use(
      http.delete(`${BASE}/api/admin/users/:userId`, ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      })
    );
    await removeAdminUser("abc-123");
    expect(capturedUrl).toContain("/api/admin/users/abc-123");
  });

  it("sends X-Requested-With header", async () => {
    let xRequestedWith: string | null = null;
    server.use(
      http.delete(`${BASE}/api/admin/users/:userId`, ({ request }) => {
        xRequestedWith = request.headers.get("x-requested-with");
        return new HttpResponse(null, { status: 204 });
      })
    );
    await removeAdminUser("user-id");
    expect(xRequestedWith).toBe("XMLHttpRequest");
  });

  // --- Error states ---

  it("throws on 409 last admin", async () => {
    server.use(
      http.delete(`${BASE}/api/admin/users/last-user`, () =>
        HttpResponse.json({ detail: "Cannot remove the last admin user." }, { status: 409 })
      )
    );
    await expect(removeAdminUser("last-user")).rejects.toThrow("HTTP 409");
  });

  it("throws on 403 self-removal", async () => {
    server.use(
      http.delete(`${BASE}/api/admin/users/self-id`, () =>
        HttpResponse.json({ detail: "Cannot remove yourself." }, { status: 403 })
      )
    );
    await expect(removeAdminUser("self-id")).rejects.toThrow("HTTP 403");
  });

  it("throws on 404 not found", async () => {
    server.use(
      http.delete(`${BASE}/api/admin/users/nonexistent`, () =>
        HttpResponse.json({ detail: "User not found." }, { status: 404 })
      )
    );
    await expect(removeAdminUser("nonexistent")).rejects.toThrow("HTTP 404");
  });
});
