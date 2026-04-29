import type { JsonObject, ToolResult, ToolSpec } from "../types";

export class ToolRegistry<TContext> {
  private readonly specs = new Map<string, ToolSpec<TContext>>();

  register(spec: ToolSpec<TContext>): void {
    if (this.specs.has(spec.name)) {
      throw new Error(`Duplicate tool registered: ${spec.name}`);
    }
    this.specs.set(spec.name, spec);
  }

  definitions(): JsonObject[] {
    return [...this.specs.values()].map((spec) => ({
      type: "function",
      name: spec.name,
      description: spec.description,
      strict: false,
      parameters: spec.parameters,
    }));
  }

  names(): string[] {
    return [...this.specs.keys()].sort();
  }

  async execute(name: string, args: JsonObject, context: TContext): Promise<ToolResult> {
    const spec = this.specs.get(name);
    if (!spec) {
      return {
        ok: false,
        text: `Unknown tool: ${name}`,
      };
    }
    try {
      return await spec.execute(args, context);
    } catch (error) {
      return {
        ok: false,
        text: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
