import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import ShareSummaryLink from "../ShareSummaryLink";

const writeTextMock = vi.fn().mockResolvedValue(undefined);

Object.defineProperty(navigator, "clipboard", {
  value: { writeText: writeTextMock },
  writable: true,
  configurable: true,
});

/** Flush all pending microtasks (resolved promises) */
function flushPromises() {
  return act(() => Promise.resolve());
}

describe("ShareSummaryLink", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writeTextMock.mockResolvedValue(undefined);
    writeTextMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the summary URL as an anchor link with correct href", () => {
    render(<ShareSummaryLink agmId="agm42" />);
    const expectedUrl = window.location.origin + "/agm/agm42/summary";
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", expectedUrl);
    expect(link).toHaveTextContent(expectedUrl);
  });

  it("link has target=_blank and rel=noopener noreferrer", () => {
    render(<ShareSummaryLink agmId="agm42" />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders 'Copy link' button initially", () => {
    render(<ShareSummaryLink agmId="agm42" />);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("changes button text to 'Link copied!' after clicking Copy link", async () => {
    render(<ShareSummaryLink agmId="agm42" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await flushPromises();
    expect(screen.getByRole("button", { name: "Link copied!" })).toBeInTheDocument();
  });

  it("resets button text back to 'Copy link' after 2000ms", async () => {
    render(<ShareSummaryLink agmId="agm42" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await flushPromises();
    expect(screen.getByRole("button", { name: "Link copied!" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("calls navigator.clipboard.writeText with the correct URL", async () => {
    render(<ShareSummaryLink agmId="agm42" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await flushPromises();
    const expectedUrl = window.location.origin + "/agm/agm42/summary";
    expect(writeTextMock).toHaveBeenCalledWith(expectedUrl);
  });

  it("still resets button after clipboard write failure, no crash", async () => {
    writeTextMock.mockRejectedValueOnce(new Error("not allowed"));
    render(<ShareSummaryLink agmId="agm42" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await flushPromises();
    // After failure, button still changes to "Link copied!"
    expect(screen.getByRole("button", { name: "Link copied!" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // And resets after timeout
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });
});
