# updateLibs

同步 `<工程>/lib` 到云端（服务端 md5 比对，增量更新，删除云端已无的本地 lib 包）。

## 参数

无。

## 示例

```json
{ "name": "updateLibs", "arguments": {} }
```

## 返回

`{ updated, deleted }`。

## 注意

- 会改动本地 `lib/`，执行前让用户确认。
