// @bap/rpc —— RPC 通信面（第一层）。
// 采用「Java 桥」路线：TS 不直接连 WebSocket、不做字节编解码/序列化，
// 而是经 stdin/stdout JSON 协议与 Java 桥进程通信，由 Java 侧复用官方 com.leavay.nio.crpc。
//
// 之前的 TS 复刻实现（Connection / Codec / Serializer / RpcClient）已移除，
// 待 Java 桥阶段（见规划 §六 第一阶段）重新实现为「子进程 + JSON」通信面。
