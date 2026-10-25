// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KenActivityBar } from "./KenActivityBar";
import { theme } from "./theme";

const baseProps = {
  runStartTs: null,
  tokens: 1234,
  isThinking: false,
  thinkingStartTs: null,
  thinkingAccumMs: 0,
  onCancel: vi.fn(),
};

describe("KenActivityBar", () => {
  it("uses the listening orb and shimmer with Ken's existing color", () => {
    const { container } = render(<KenActivityBar {...baseProps} />);
    const orb = container.querySelector("canvas");
    expect(orb?.getAttribute("aria-label")).toBe("Listening…");
    expect(orb?.getAttribute("aria-hidden")).toBe("true");
    expect(orb?.style.width).toBe("20px");
    const filter = container.querySelector("filter");
    expect(orb?.style.filter).toBe(`url("#${filter?.id}")`);
    const flood = container.querySelector<SVGElement>("feFlood");
    expect(flood?.style.getPropertyValue("flood-color")).toBe(theme.ken);
    const label = screen.getByText("@Mentor is thinking…");
    expect(label.classList.contains("shimmer-text")).toBe(true);
    expect(label.style.getPropertyValue("--shimmer-base")).toBe(theme.ken);
  });

  it("preserves token counts, thinking feedback, and cancellation", () => {
    const onCancel = vi.fn();
    render(<KenActivityBar {...baseProps} isThinking thinkingAccumMs={2000} onCancel={onCancel} />);
    expect(screen.getByText("↓ 1.2k tokens")).toBeTruthy();
    expect(screen.getByText("thinking for 2s")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "esc to cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
