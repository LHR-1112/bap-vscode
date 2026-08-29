// @bap/sdk —— 业务能力封装（第二层）。
// 面向业务，不暴露 RPC：
//   sdk.login() / sdk.publish.gray() / sdk.project.list() / sdk.code.save()
// 而不是 rpc.invoke(...)。

export interface BapSdk {
  login(): Promise<void>;
}
