import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock pino logger so we don't need real logging infra
vi.mock("../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock workspace paths (needed by secrets SDK)
vi.mock("../../workspace/paths.js", () => ({
  TELETON_ROOT: "/tmp/teleton-logger-test",
}));

import { createPluginSDK } from "../index.js";
import type { PluginSDK } from "@teleton-agent/sdk";

const mockBridge = {
  isAvailable: vi.fn(() => true),
  getClient: () => ({
    getClient: () => ({
      invoke: vi.fn(),
      sendMessage: vi.fn(),
      sendFile: vi.fn(),
      getEntity: vi.fn(),
      getInputEntity: vi.fn(),
      getMessages: vi.fn(),
      downloadMedia: vi.fn(),
      uploadFile: vi.fn(),
    }),
    getMe: vi.fn(),
    answerCallbackQuery: vi.fn(),
  }),
  sendMessage: vi.fn(),
  editMessage: vi.fn(),
  sendReaction: vi.fn(),
  setTyping: vi.fn(),
  getMessages: vi.fn(),
} as any;

describe("SDK Logger wrapper", () => {
  let sdk: PluginSDK;

  beforeEach(() => {
    sdk = createPluginSDK(
      { bridge: mockBridge },
      {
        pluginName: "logger-test",
        db: null,
        sanitizedConfig: {},
        pluginConfig: {},
      }
    );
  });

  describe("method existence", () => {
    it("has info, warn, error, debug methods", () => {
      expect(typeof sdk.log.info).toBe("function");
      expect(typeof sdk.log.warn).toBe("function");
      expect(typeof sdk.log.error).toBe("function");
      expect(typeof sdk.log.debug).toBe("function");
    });

    it("has no extra properties beyond the 4 log methods", () => {
      const keys = Object.keys(sdk.log).sort();
      expect(keys).toEqual(["debug", "error", "info", "warn"]);
    });
  });

  describe("callable without error", () => {
    it("accepts a single string argument", () => {
      expect(() => sdk.log.info("hello")).not.toThrow();
      expect(() => sdk.log.warn("warning")).not.toThrow();
      expect(() => sdk.log.error("error")).not.toThrow();
      expect(() => sdk.log.debug("debug")).not.toThrow();
    });

    it("accepts multiple arguments", () => {
      expect(() => sdk.log.info("a", "b", "c")).not.toThrow();
      expect(() => sdk.log.warn("x", "y")).not.toThrow();
      expect(() => sdk.log.error("e1", "e2", "e3")).not.toThrow();
      expect(() => sdk.log.debug("d1", "d2")).not.toThrow();
    });

    it("accepts no arguments", () => {
      expect(() => sdk.log.info()).not.toThrow();
      expect(() => sdk.log.warn()).not.toThrow();
      expect(() => sdk.log.error()).not.toThrow();
      expect(() => sdk.log.debug()).not.toThrow();
    });
  });

  describe("non-string arguments", () => {
    it("handles numbers", () => {
      expect(() => sdk.log.info(42 as any)).not.toThrow();
      expect(() => sdk.log.warn(0 as any, -1 as any)).not.toThrow();
    });

    it("handles objects and arrays", () => {
      expect(() => sdk.log.info({ key: "val" } as any)).not.toThrow();
      expect(() => sdk.log.debug([1, 2, 3] as any)).not.toThrow();
    });

    it("handles null and undefined", () => {
      expect(() => sdk.log.error(null as any)).not.toThrow();
      expect(() => sdk.log.warn(undefined as any)).not.toThrow();
    });
  });

  describe("frozen", () => {
    it("sdk.log is frozen", () => {
      expect(Object.isFrozen(sdk.log)).toBe(true);
    });
  });
});
