import { describe, expect, it } from "vitest";
import { expandBlueprint } from "../src/blueprint/Blueprint";

describe("Blueprint", () => {
  it("expands non-empty palette cells into block placements", () => {
    const blueprint = expandBlueprint({
      name: "test",
      palette: {
        A: "stone",
        B: "glass",
      },
      layers: [
        ["A.", " B"],
        ["BA", ".."],
      ],
    });

    expect(blueprint.size).toEqual({ x: 2, y: 2, z: 2 });
    expect(blueprint.placements).toEqual([
      { block: "stone", char: "A", position: { x: 0, y: 0, z: 0 } },
      { block: "glass", char: "B", position: { x: 1, y: 0, z: 1 } },
      { block: "glass", char: "B", position: { x: 0, y: 1, z: 0 } },
      { block: "stone", char: "A", position: { x: 1, y: 1, z: 0 } },
    ]);
  });

  it("rejects unmapped palette characters", () => {
    expect(() =>
      expandBlueprint({
        name: "bad",
        palette: { A: "stone" },
        layers: [["AZ"]],
      }),
    ).toThrow(/unmapped/);
  });
});
