import type { WebMcpModelContext, WebMcpNativeTool } from "./types";

const domError = (message: string, name: string) =>
  new DOMException(message, name);

export type WebMcpTestContext = WebMcpModelContext & {
  executeTool: (name: string, input: object) => Promise<unknown>;
  getTools: () => WebMcpNativeTool[];
};

export const createWebMcpTestContext = (): WebMcpTestContext => {
  const target = new EventTarget();
  const tools = new Map<
    string,
    { abort?: () => void; tool: WebMcpNativeTool }
  >();
  let ontoolchange: ((event: Event) => unknown) | null = null;
  const changed = () => {
    const event = new Event("toolchange");
    target.dispatchEvent(event);
    ontoolchange?.(event);
  };
  Object.defineProperties(target, {
    executeTool: {
      value: async (name: string, input: object) => {
        const registered = tools.get(name);
        if (!registered) throw domError("Unknown WebMCP tool", "NotFoundError");
        return registered.tool.execute(input);
      },
    },
    getTools: {
      value: () => [...tools.values()].map(({ tool }) => tool),
    },
    ontoolchange: {
      configurable: true,
      get: () => ontoolchange,
      set: (listener: ((event: Event) => unknown) | null) => {
        ontoolchange = listener;
      },
    },
    registerTool: {
      value: async (
        tool: WebMcpNativeTool,
        options?: { exposedTo?: string[]; signal?: AbortSignal },
      ) => {
        if (tools.has(tool.name))
          throw domError(
            "WebMCP tool name is already registered",
            "InvalidStateError",
          );
        if (
          !/^[A-Za-z0-9_.-]{1,128}$/u.test(tool.name) ||
          tool.description === ""
        )
          throw domError("Invalid WebMCP tool", "InvalidStateError");
        if (options?.signal?.aborted) throw options.signal.reason;
        JSON.stringify(tool.inputSchema);
        const abort = () => {
          if (tools.delete(tool.name)) changed();
        };
        options?.signal?.addEventListener("abort", abort, { once: true });
        tools.set(tool.name, { abort, tool });
        changed();
      },
    },
  });
  return target as WebMcpTestContext;
};
