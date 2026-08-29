// @bap/rpc —— RPC Runtime（第一层）。
// 第一阶段：Connection（WebSocket / 重连 / Ping / Timeout）。

/** RPC 连接的生命周期接口（占位，待第一阶段实现）。 */
export interface RpcConnection {
  connect(): Promise<void>;
  close(): void;
}
