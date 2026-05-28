import { AsyncLocalStorage } from "async_hooks";
import type { AppContext } from "./types";

export type { AppContext };

const storage = new AsyncLocalStorage<AppContext>();

export const getCtx = (): AppContext => {
  const ctx = storage.getStore();
  if (!ctx) throw new Error("getCtx called outside runWithCtx");
  return ctx;
};

export const runWithCtx = <T>(ctx: AppContext, fn: () => T): T =>
  storage.run(ctx, fn);
