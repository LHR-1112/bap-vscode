# updateAll

更新全部变更：从云端取最新覆盖本地，删除本地新增文件，即「全部回退到云端」。

## 参数

无。

## 示例

```json
{ "name": "updateAll", "arguments": {} }
```

## 返回

更新完成信息。

## 注意

- 会覆盖本地所有改动，不可逆；执行前让用户确认。
- `updateAll` / `updateFile` / `updateGroup` 语义一致：都是回退到云端。
