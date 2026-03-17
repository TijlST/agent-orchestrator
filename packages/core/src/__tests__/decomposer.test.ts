import { describe, it, expect, vi } from "vitest";
import {
  decompose,
  resolveDecomposerProvider,
  DEFAULT_DECOMPOSER_CONFIG,
  type DecomposerConfig,
  type DecompositionProvider,
} from "../decomposer.js";

describe("resolveDecomposerProvider", () => {
  it("defaults to openai provider", () => {
    expect(resolveDecomposerProvider(DEFAULT_DECOMPOSER_CONFIG)).toBe("openai");
  });

  it("respects explicit provider override", () => {
    const config: DecomposerConfig = {
      ...DEFAULT_DECOMPOSER_CONFIG,
      provider: "anthropic",
    };
    expect(resolveDecomposerProvider(config)).toBe("anthropic");
  });
});

describe("decompose", () => {
  it("builds a decomposition plan via injected provider", async () => {
    const provider: DecompositionProvider = {
      complete: vi
        .fn()
        .mockResolvedValueOnce("composite")
        .mockResolvedValueOnce('["Implement API", "Implement UI"]')
        .mockResolvedValueOnce("atomic")
        .mockResolvedValueOnce("atomic"),
    };

    const plan = await decompose(
      "Build dashboard feature",
      {
        ...DEFAULT_DECOMPOSER_CONFIG,
        maxDepth: 3,
        requireApproval: true,
      },
      { provider },
    );

    expect(plan.phase).toBe("review");
    expect(plan.tree.kind).toBe("composite");
    expect(plan.tree.children).toHaveLength(2);
    expect(plan.tree.children.map((c) => c.description)).toEqual(["Implement API", "Implement UI"]);
    expect(provider.complete).toHaveBeenCalledTimes(4);
  });

  it("marks plan approved when requireApproval is false", async () => {
    const provider: DecompositionProvider = {
      complete: vi.fn().mockResolvedValue("atomic"),
    };

    const plan = await decompose(
      "Small change",
      {
        ...DEFAULT_DECOMPOSER_CONFIG,
        requireApproval: false,
      },
      { provider },
    );

    expect(plan.phase).toBe("approved");
  });
});
