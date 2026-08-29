import type { CallbackHandler } from './types';

/** callbackUuid → handler 的注册表。 */
export class CallbackRegistry {
  private _handlers = new Map<string, CallbackHandler>();

  register(uuid: string, handler: CallbackHandler): void {
    this._handlers.set(uuid, handler);
  }

  unregister(uuid: string): boolean {
    return this._handlers.delete(uuid);
  }

  get(uuid: string): CallbackHandler | undefined {
    return this._handlers.get(uuid);
  }
}
