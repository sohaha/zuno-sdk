/**
 * 服务端级事件流：把所有会话的事件汇聚到一个迭代器。
 */

import { HarnessError } from "../utils/harness-error.js";
import type { AnyApiEvent } from "../protocol/harness-protocol.js";

/** `globalEvents` 所需的最小客户端形状。 */
export interface GlobalEventsClient {
  on(event: "close", listener: (error?: Error) => void): this;
  off(event: "close", listener: (error?: Error) => void): this;
  readonly closed: boolean;
  readonly closeError?: Error;
  readonly socketPath?: string;
  readonly clientName: string;
  readonly requestTimeoutMs: number;
  listSessions(options: { includeArchived?: boolean; limit?: number }): Promise<Array<{ session_id: string }>>;
}

export type ChildConnector = (sessionId: string) => Promise<ChildHandle>;

export interface ChildHandle {
  events(sessionId: string): AsyncIterableIterator<AnyApiEvent>;
  attachSession(sessionId: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface GlobalEventsOptions {
  signal?: AbortSignal;
  discoveryIntervalMs?: number;
  maxBufferedEvents?: number;
}

export function globalEvents(
  parent: GlobalEventsClient,
  connect: ChildConnector,
  options: GlobalEventsOptions = {},
): AsyncIterableIterator<AnyApiEvent> {
  if (!parent.socketPath) {
    throw new HarnessError(
      "unsupported_transport",
      "globalEvents 需要原生 socket 连接；自定义 transport 无法克隆为每会话子连接",
    );
  }
  if (parent.closed) {
    throw parent.closeError ?? new HarnessError("disconnected", "harness 连接已关闭");
  }

  const discoveryIntervalMs = options.discoveryIntervalMs ?? 1_000;
  const maxBufferedEvents = options.maxBufferedEvents ?? 10_000;
  if (!Number.isFinite(discoveryIntervalMs) || discoveryIntervalMs < 0) {
    throw new HarnessError("invalid_option", "discoveryIntervalMs 必须是 >= 0 的有限数");
  }
  if (!Number.isInteger(maxBufferedEvents) || maxBufferedEvents < 1) {
    throw new HarnessError("invalid_option", "maxBufferedEvents 必须是正整数");
  }

  type Waiter = {
    resolve: (result: IteratorResult<AnyApiEvent>) => void;
    reject: (error: Error) => void;
  };
  type Child = {
    client: ChildHandle;
    stream: AsyncIterableIterator<AnyApiEvent>;
    pump?: Promise<void>;
  };

  const queue: AnyApiEvent[] = [];
  const children = new Map<string, Child>();
  const starting = new Set<string>();
  const startTasks = new Set<Promise<void>>();
  let waiter: Waiter | undefined;
  let stopped = false;
  let terminalError: Error | undefined;
  let discoveryTimer: NodeJS.Timeout | undefined;
  let cleanupPromise: Promise<void> | undefined;

  const settleWaiter = () => {
    if (!waiter) return;
    const pending = waiter;
    waiter = undefined;
    if (terminalError) pending.reject(terminalError);
    else pending.resolve({ value: undefined as never, done: true });
  };

  const onParentClose = (error?: Error) => {
    void finish(error);
  };
  const onAbort = () => {
    void finish();
  };

  const finish = (error?: Error): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    stopped = true;
    terminalError = error;
    queue.length = 0;
    if (discoveryTimer) clearTimeout(discoveryTimer);
    parent.off("close", onParentClose);
    options.signal?.removeEventListener("abort", onAbort);
    settleWaiter();

    const closing: Promise<unknown>[] = [];
    for (const { client, stream, pump } of children.values()) {
      closing.push(Promise.resolve(stream.return?.(undefined as never)));
      closing.push(client.close());
      if (pump) closing.push(pump);
    }
    children.clear();
    closing.push(...startTasks);
    cleanupPromise = Promise.allSettled(closing).then(() => undefined);
    return cleanupPromise;
  };

  const enqueue = (event: AnyApiEvent) => {
    if (stopped) return;
    if (waiter) {
      const pending = waiter;
      waiter = undefined;
      pending.resolve({ value: event, done: false });
      return;
    }
    if (queue.length >= maxBufferedEvents) {
      void finish(
        new HarnessError(
          "event_buffer_overflow",
          `globalEvents 消费方落后，缓冲事件已达 ${maxBufferedEvents} 条`,
        ),
      );
      return;
    }
    queue.push(event);
  };

  const startChild = async (sessionId: string): Promise<void> => {
    if (stopped || children.has(sessionId) || starting.has(sessionId)) return;
    starting.add(sessionId);
    let child: ChildHandle | undefined;
    try {
      child = await connect(sessionId);
      if (stopped) {
        await child.close();
        return;
      }
      const stream = child.events(sessionId);
      const childState: Child = { client: child, stream };
      children.set(sessionId, childState);
      await child.attachSession(sessionId);
      if (stopped) return;

      const pump = (async () => {
        try {
          for await (const event of stream) enqueue(event);
        } finally {
          if (children.get(sessionId) === childState) children.delete(sessionId);
          await childState.client.close();
        }
      })();
      childState.pump = pump;
      void pump;
    } catch (error) {
      if (child && children.get(sessionId)?.client === child) children.delete(sessionId);
      await child?.close();
      if (
        !stopped &&
        !(error instanceof HarnessError && error.code === "unknown_session")
      ) {
        void finish(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      starting.delete(sessionId);
    }
  };

  const scan = async (): Promise<void> => {
    if (stopped) return;
    try {
      const sessions = await parent.listSessions({ includeArchived: true });
      if (stopped) return;
      const tasks = sessions.map((session) => {
        const task = startChild(session.session_id);
        startTasks.add(task);
        void task.finally(() => startTasks.delete(task));
        return task;
      });
      await Promise.allSettled(tasks);
    } catch (error) {
      if (!stopped) void finish(error instanceof Error ? error : new Error(String(error)));
    }
    if (!stopped && discoveryIntervalMs > 0) {
      discoveryTimer = setTimeout(() => void scan(), discoveryIntervalMs);
      discoveryTimer.unref?.();
    }
  };

  parent.on("close", onParentClose);
  if (options.signal?.aborted) void finish();
  else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
    void scan();
  }

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }
      if (terminalError) return Promise.reject(terminalError);
      if (stopped) {
        return Promise.resolve({ value: undefined as never, done: true });
      }
      if (waiter) {
        return Promise.reject(
          new HarnessError("concurrent_next", "globalEvents 不支持并发调用 next()"),
        );
      }
      return new Promise<IteratorResult<AnyApiEvent>>((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },
    return: async () => {
      await finish();
      return { value: undefined as never, done: true };
    },
    throw: async (error?: unknown) => {
      await finish();
      throw error;
    },
  };
}
