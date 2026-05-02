import { describe, expect, it } from "vitest";
import { VisualPerception } from "../src/vision/VisualPerception";
import type { ScreenPlacementHit } from "../src/bot/MinecraftBot";

function makePerception(): VisualPerception {
  return new VisualPerception({} as never, {
    vision: {
      width: 40,
      height: 20,
      sampleWidth: 4,
      sampleHeight: 2,
    },
  } as never);
}

function makePoseAwarePerception() {
  const raw = {
    entity: {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0,
    },
  };
  return {
    raw,
    perception: new VisualPerception({ raw } as never, {
      vision: {
        width: 40,
        height: 20,
        sampleWidth: 4,
        sampleHeight: 2,
        horizontalFovDeg: 70,
      },
    } as never),
  };
}

describe("VisualPerception target localization", () => {
  it("returns a screen coordinate that resolves back to the selected visible target", () => {
    const perception = makePerception();
    const hit: ScreenPlacementHit = {
      blockName: "oak_log",
      blockPosition: { x: 10, y: 64, z: 10 },
      distance: 4,
    };
    (perception as unknown as { lastHits: Array<ScreenPlacementHit | undefined> }).lastHits = [
      undefined,
      undefined,
      undefined,
      undefined,
      hit,
      undefined,
      undefined,
      { ...hit, distance: 5 },
    ];

    const [target] = perception.findVisibleTargets(["oak_log"], "exact", 1);
    const resolved = perception.hitFromScreen(target.screen.x, target.screen.y);

    expect(resolved?.blockName).toBe("oak_log");
    expect(resolved?.blockPosition).toEqual(hit.blockPosition);
  });

  it("reports the visible screen box for each target", () => {
    const perception = makePerception();
    const hit: ScreenPlacementHit = {
      blockName: "oak_log",
      blockPosition: { x: 10, y: 64, z: 10 },
      distance: 4,
    };
    (perception as unknown as { lastHits: Array<ScreenPlacementHit | undefined> }).lastHits = [
      hit,
      hit,
      undefined,
      undefined,
      undefined,
      hit,
      undefined,
      undefined,
    ];

    const [target] = perception.findVisibleTargets(["oak_log"], "exact", 1);

    expect(target.screenBox).toEqual({
      minX: 0,
      minY: 0,
      maxX: 20,
      maxY: 20,
      width: 20,
      height: 20,
    });
  });

  it("does not reuse screen hits after the bot has moved away from the captured pose", () => {
    const { raw, perception } = makePoseAwarePerception();
    const hit: ScreenPlacementHit = {
      blockName: "oak_log",
      blockPosition: { x: 10, y: 64, z: 10 },
      distance: 4,
    };
    (perception as unknown as { lastHits: Array<ScreenPlacementHit | undefined> }).lastHits = [
      undefined,
      undefined,
      undefined,
      undefined,
      hit,
      undefined,
      undefined,
      undefined,
    ];
    (perception as unknown as { lastFramePose: unknown }).lastFramePose = {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0,
    };

    raw.entity.position = { x: 2, y: 64, z: 0 };

    expect(perception.hitFromScreen(5, 15)).toBeUndefined();
  });
});
