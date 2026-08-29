import { BASE_WIRE_HANDLE } from './constants';
import { HandleTableError } from './errors';

/**
 * 对象引用表（handle table），双向复刻 Java ObjectOutputStream/ObjectInputStream。
 *
 * 写侧：每次「新写一个对象/classdesc/字符串/数组」用 assign() 分配下一个 handle（从 baseWireHandle 递增），
 * 并把该值记录下来，下次同一对象出现时写 TC_REFERENCE + handle 而非重写。
 *
 * 读侧：读到一个新对象后 register() 用下一个 handle 登记；碰到 TC_REFERENCE 时 resolve(handle) 取回已登记对象。
 *
 * 关键：写/读两侧的 handle 分配序号必须完全一致，否则 TC_REFERENCE 会错位。
 */
export class HandleTable {
  private _next: number = BASE_WIRE_HANDLE;
  private _byHandle = new Map<number, unknown>();
  private _lookup = new Map<unknown, number>();

  get next(): number {
    return this._next;
  }

  /** 写侧：分配下一个 handle 并登记该值，返回 handle。 */
  assign(value: unknown): number {
    const h = this._next++;
    this._byHandle.set(h, value);
    if (value !== null && (typeof value === 'object' || typeof value === 'string')) {
      this._lookup.set(value, h);
    }
    return h;
  }

  /** 写侧：查询该值此前是否已分配过 handle；有则返回 handle，无则返回 undefined。 */
  lookup(value: unknown): number | undefined {
    if (value === null || (typeof value !== 'object' && typeof value !== 'string')) return undefined;
    return this._lookup.get(value);
  }

  /** 读侧：读取 handle 时确认下一个未被占用的 handle，并返回它（供 register 使用）。 */
  nextHandle(): number {
    return this._next;
  }

  /** 读侧：把读到的新对象登记到当前 handle，并推进。 */
  register(value: unknown, handle: number): void {
    this._byHandle.set(handle, value);
    this._next = handle + 1;
  }

  /** 读侧：通过 TC_REFERENCE 的 handle 取回此前登记的对象。 */
  resolve(handle: number): unknown {
    if (!this._byHandle.has(handle)) {
      throw new HandleTableError(`reference to unknown handle 0x${handle.toString(16)}`);
    }
    return this._byHandle.get(handle);
  }

  /** 写侧：读侧共用于把 handle 推进到指定值（如读 classdesc 后推进）。 */
  setNext(handle: number): void {
    this._next = handle;
  }
}
