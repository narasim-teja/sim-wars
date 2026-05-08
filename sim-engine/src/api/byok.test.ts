import { describe, expect, it } from "bun:test";
import {
  isPlausibleOpenRouterKey,
  isPlausibleHeliusInput,
  normalizeHeliusUrl,
} from "./byok";

describe("isPlausibleOpenRouterKey", () => {
  it("accepts well-formed sk-or-… keys", () => {
    expect(isPlausibleOpenRouterKey("sk-or-v1-" + "a".repeat(48))).toBe(true);
    expect(isPlausibleOpenRouterKey("sk-or-abc123")).toBe(true);
  });

  it("rejects empty and non-string values", () => {
    expect(isPlausibleOpenRouterKey("")).toBe(false);
    expect(isPlausibleOpenRouterKey(null)).toBe(false);
    expect(isPlausibleOpenRouterKey(undefined)).toBe(false);
    expect(isPlausibleOpenRouterKey(42 as unknown)).toBe(false);
  });

  it("rejects keys with the wrong prefix", () => {
    expect(isPlausibleOpenRouterKey("sk-anthropic-abc")).toBe(false);
    expect(isPlausibleOpenRouterKey("sk-proj-abc")).toBe(false);
    expect(isPlausibleOpenRouterKey("not-a-key")).toBe(false);
  });

  it("rejects oversized inputs (>200 chars)", () => {
    expect(isPlausibleOpenRouterKey("sk-or-" + "a".repeat(300))).toBe(false);
  });
});

describe("isPlausibleHeliusInput", () => {
  it("accepts a bare API key (8–80 alphanumerics)", () => {
    expect(isPlausibleHeliusInput("abc12345")).toBe(true);
    expect(isPlausibleHeliusInput("abcd-efgh-1234-5678")).toBe(true);
    expect(isPlausibleHeliusInput("a".repeat(40))).toBe(true);
  });

  it("rejects bare keys that are too short or long", () => {
    expect(isPlausibleHeliusInput("abc")).toBe(false); // 3 chars
    expect(isPlausibleHeliusInput("a".repeat(120))).toBe(false); // > 80, but short of 300, so URL parser kicks in but it's not a URL → falls through
  });

  it("accepts a full Helius devnet URL with api-key", () => {
    expect(
      isPlausibleHeliusInput(
        "https://devnet.helius-rpc.com/?api-key=" + "x".repeat(36),
      ),
    ).toBe(true);
  });

  it("accepts a full Helius mainnet URL with api-key", () => {
    expect(
      isPlausibleHeliusInput(
        "https://mainnet.helius-rpc.com/?api-key=abcdef",
      ),
    ).toBe(true);
  });

  it("rejects http (non-https) URLs", () => {
    expect(
      isPlausibleHeliusInput(
        "http://devnet.helius-rpc.com/?api-key=abc",
      ),
    ).toBe(false);
  });

  it("rejects non-Helius hosts", () => {
    expect(
      isPlausibleHeliusInput("https://api.devnet.solana.com/?api-key=abc"),
    ).toBe(false);
    expect(isPlausibleHeliusInput("https://evil.example.com/?api-key=abc")).toBe(
      false,
    );
  });

  it("rejects Helius URLs that don't carry an api-key", () => {
    expect(isPlausibleHeliusInput("https://devnet.helius-rpc.com/")).toBe(false);
    expect(
      isPlausibleHeliusInput("https://devnet.helius-rpc.com/?other=value"),
    ).toBe(false);
  });

  it("rejects empty / non-string", () => {
    expect(isPlausibleHeliusInput("")).toBe(false);
    expect(isPlausibleHeliusInput(null)).toBe(false);
    expect(isPlausibleHeliusInput(undefined)).toBe(false);
  });

  it("rejects oversized inputs (>300 chars)", () => {
    const huge =
      "https://devnet.helius-rpc.com/?api-key=" + "a".repeat(400);
    expect(isPlausibleHeliusInput(huge)).toBe(false);
  });
});

describe("normalizeHeliusUrl", () => {
  it("passes through full https:// URLs verbatim", () => {
    const url = "https://devnet.helius-rpc.com/?api-key=abc123";
    expect(normalizeHeliusUrl(url)).toBe(url);
  });

  it("wraps a bare API key into the standard devnet URL", () => {
    expect(normalizeHeliusUrl("abc-123-XYZ")).toBe(
      "https://devnet.helius-rpc.com/?api-key=abc-123-XYZ",
    );
  });

  it("trims whitespace", () => {
    expect(normalizeHeliusUrl("  abc123  ")).toBe(
      "https://devnet.helius-rpc.com/?api-key=abc123",
    );
  });

  it("URL-encodes funky characters in bare keys (defensive)", () => {
    expect(normalizeHeliusUrl("a b")).toBe(
      "https://devnet.helius-rpc.com/?api-key=a%20b",
    );
  });
});
