import { AsyncLocalStorage } from 'node:async_hooks';
import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';

type WorkToken = { active: boolean; handoff?: boolean; owned?: boolean };
const errorCapability = Symbol('owned error dispatch');


export interface OwnedDispatch {
  run<T>(work: () => Promise<T> | T): Promise<T> | undefined;
  terminal(): void;
  forwardError(error: unknown, dispatch: (error: Error) => void): void;
}

type ControlledRoot = { ingress: ControlledToken; terminal: boolean };
type ControlledToken = { active: boolean; root?: ControlledRoot };

/**
 * Primitive for an explicitly audited dispatch graph; not connected to server
 * shutdown. Call terminal only at a proven dispatch endpoint, never on socket
 * close or merely because next() returned. Every asynchronous producer capable
 * of work must be registered with run before it is scheduled.
 */
export class ControlledIngress {
  private accepting = true;
  private active = 0;
  private waiters: Array<() => void> = [];
  #context = new AsyncLocalStorage<ControlledToken>();

  private acquire(root?: ControlledRoot): ControlledToken {
    this.active++;
    return { active: true, root };
  }

  private release(token: ControlledToken): void {
    if (!token.active) return;
    token.active = false;
    if (--this.active === 0) {
      for (const resolve of this.waiters.splice(0)) resolve();
    }
  }

  /** Admission happens before the first application middleware is dispatched. */
  ingress(dispatch: () => unknown): boolean {
    if (!this.accepting) return false;
    const token = this.acquire();
    const root: ControlledRoot = { ingress: token, terminal: false };
    token.root = root;
    // Even a synchronous throw cannot prove that dispatch scheduled no work.
    this.#context.run(token, dispatch);
    return true;
  }

  /** Mark an audited terminal point; child tasks retain independent ownership. */
  terminal(): boolean {
    const current = this.#context.getStore();
    const root = current?.active ? current.root : undefined;
    if (!root || root.terminal) return false;
    root.terminal = true;
    this.release(root.ingress);
    return true;
  }

  run<T>(work: () => Promise<T> | T, _untrustedIdentity?: object): Promise<T> | undefined {
    if (!this.accepting) return undefined;
    const token = this.acquire();
    let result: Promise<T>;
    try { result = Promise.resolve(this.#context.run(token, work)); }
    catch (error) { result = Promise.reject(error); }
    return result.finally(() => this.release(token));
  }

  stopAndDrain(): Promise<void> {
    this.accepting = false;
    if (this.active === 0) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

/** Tracks only explicitly registered request work; not a complete server drain. */
export class RequestWorkManager {
  private accepting = true;
  private active = 0;
  private waiters: Array<() => void> = [];
  #context = new AsyncLocalStorage<WorkToken>();
  #errors = new WeakMap<object, { root: WorkToken; error: Error; capability: object }>();


  /** Synchronous admission check; endpoints still acquire their own lease. */
  isAccepting(): boolean { return this.accepting; }

  /** A router retains this capability until its audited dispatch endpoint. */
  ownedDispatch(dispatch: (scope: OwnedDispatch) => void): boolean {
    if (!this.accepting) return false;
    const root: WorkToken = { active: true, owned: true };
    this.active++;
    const scope: OwnedDispatch = {
      run: <T>(work: () => Promise<T> | T) => {
        if (!root.active) return undefined;
        return this.start(work, root, false);
      },
      terminal: () => this.release(root),
      forwardError: (error, deliver) => {
        // Never retain or forward an untrusted thrown value or its properties.
        const original = new Error('Internal server error.');
        const wrapper = new Error('Owned error dispatch');
        const capability = {};
        Object.defineProperty(wrapper, errorCapability, { value: capability });
        this.#errors.set(wrapper, { root, error: original, capability });
        // Delivery may schedule a continuation before throwing.
        deliver(wrapper);
      },
    };
    this.#context.run(root, () => dispatch(scope));
    return true;
  }



  claimError(error: unknown): { error: Error; run: OwnedDispatch['run']; terminal: () => void } | undefined {
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined;
    const entry = this.#errors.get(error as object);
    if (!entry || !entry.root.active) return undefined;
    this.#errors.delete(error as object);
    return {
      error: entry.error,
      run: <T>(work: () => Promise<T> | T) => this.start(work, entry.root, false),
      terminal: () => this.release(entry.root),
    };
  }

  private release(token: WorkToken): void {
    if (!token.active) return;
    token.active = false;
    this.active--;
    if (this.active === 0) {
      for (const resolve of this.waiters.splice(0)) resolve();
    }
  }

  /** Admission and reference acquisition happen synchronously, before work starts. */
  run<T>(work: () => Promise<T> | T, _continuation?: object): Promise<T> | undefined {
    // Inherited async context is not authority to admit a new root.
    if (!this.accepting) return undefined;
    return this.start(work, undefined, false);
  }

  /**
   * Provisional: async context is inherited by other continuations too, so it
   * does not authenticate an Express dispatch. Do not use this as a shutdown
   * safety boundary until dispatch ownership is bound and independently tested.
   */
  runDispatch<T>(work: () => Promise<T> | T): Promise<T> | undefined {
    if (!this.accepting) return undefined;
    const parent = this.#context.getStore();
    return this.start(work, parent, true);
  }

  private start<T>(work: () => Promise<T> | T, parent: WorkToken | undefined, claim: boolean): Promise<T> | undefined {
    if (!this.accepting && !parent?.active) return undefined;
    const token: WorkToken = { active: true, owned: parent?.owned };
    this.active++;
    if (claim && parent?.handoff) this.release(parent);
    let result: Promise<T>;
    try { result = Promise.resolve(this.#context.run(token, work)); }
    catch (error) { result = Promise.reject(error); }
    return result.finally(() => {
      this.release(token);
    });
  }

  /** Own dispatch before next(): Express can defer reaching the next layer. */
  handoff<T>(_request: object, next: () => T): T {
    const token = this.#context.getStore();
    if (token?.active) {
      const lease: WorkToken = { active: true, handoff: true };
      this.active++;
      // Express may schedule its continuation with setImmediate. Async context
      // follows that dispatch, without making the request itself a capability.
      try { return this.#context.run(lease, next); }
      catch (error) { throw error; }
    }
    // An unclaimed dispatch is intentionally retained: neither a closed socket
    // nor return from next() proves that Express has stopped dispatching.
    return next();
  }

  /** Atomically deny new work and wait for admitted work to settle. */
  stopAndDrain(): Promise<void> {
    this.accepting = false;
    if (this.active === 0) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

export const requestWork = new RequestWorkManager();

/** Express 4 ignores returned promises: explicitly own the actual handler. */
export function trackedErrorHandler(handler: ErrorRequestHandler, manager = requestWork): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    const claimed = manager.claimError(error);
    const run = claimed ? claimed.run : manager.runDispatch.bind(manager);
    const work = run(async () => {
      const trackedNext: NextFunction = ((...args: Parameters<NextFunction>) => manager.handoff(req, () => next(...args))) as NextFunction;
      try { await handler(claimed ? claimed.error : error, req, res, trackedNext); }
      catch {
        try {
          if (res.destroyed || res.writableEnded) return;
          if (res.headersSent) res.destroy();
          else res.status(500).json({ error: { type: 'internal_error', message: 'Internal server error.' } });
        } catch { try { res.destroy(); } catch { /* best effort */ } }
      } finally { claimed?.terminal(); }
    });

    if (work) void work;
    else {
      try { if (res.headersSent) res.destroy(); else res.status(503).json({ error: { type: 'service_unavailable', message: 'Server is shutting down.' } }); }
      catch { try { res.destroy(); } catch { /* best effort */ } }
    }
  };
}
