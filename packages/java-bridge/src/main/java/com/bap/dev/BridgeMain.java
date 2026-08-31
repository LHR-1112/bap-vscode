package com.bap.dev;

import bap.java.CJavaCenterIntf;
import bap.java.CJavaFolderDto;
import com.cdao.CDaoConst;
import com.cdao.mgr.CSession;
import com.leavay.common.gson.Gson;
import com.leavay.common.gson.JsonSyntaxException;
import com.leavay.common.util.GsonUtil;
import com.leavay.common.util.ProgressCtrl.ProgressControllerFEIntf;
import com.leavay.common.util.ProgressCtrl.crpc.CProgressProxy;
import com.leavay.common.util.ProgressCtrl.crpc.IProgress;
import com.leavay.common.util.ZipUtils;
import com.leavay.nio.crpc.CRpcAdapter;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Java 桥入口：经 stdin/stdout JSON-lines 与 TS 通信。
 *
 * 只暴露「原子化能力」：
 *   connect(uri,user,pwd)  连接 + 登录（会话入全局 context）
 *   call(method, args)     反射转发 CJavaCenterIntf 的原子方法
 *   disconnect / ping / shutdown
 *
 * stdout 只写协议帧；所有日志/Netty/slf4j/JUL 输出到 stderr（log4j.properties）。
 */
public class BridgeMain {
    private static final Logger LOG = Logger.getLogger(BridgeMain.class.getName());

    // 序列化：字段反射 + 禁用 HTML 转义，排除 static/transient
    private static final Gson GSON = GsonUtil.newSimpleGsonBuilder()
            .disableHtmlEscaping()
            .excludeFieldsWithModifiers(Modifier.STATIC, Modifier.TRANSIENT)
            .create();

    private static final PrintStream OUT = new PrintStream(System.out, true);
    private static final Object OUT_LOCK = new Object();

    // 请求 JSON 映射
    private static class Req {
        long id;
        String method;
        Object[] params;
    }

    public static void main(String[] args) throws Exception {
        redirectSystemOutToStderr();
        quietJdkLogging();

        BapRpcClient client = new BapRpcClient();
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));

        String line;
        while ((line = in.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) continue;

            Req req;
            try {
                req = GSON.fromJson(line, Req.class);
            } catch (RuntimeException e) {
                writeErr(-1, "bad_json", e.getMessage());
                continue;
            }
            if (req == null || req.method == null) {
                writeErr(req == null ? -1 : req.id, "bad_json", "missing method");
                continue;
            }

            try {
                dispatch(client, req);
            } catch (InvocationTargetException e) {
                Throwable cause = e.getCause() != null ? e.getCause() : e;
                writeErr(req.id, cause.getClass().getName(), cause.getMessage());
            } catch (Throwable t) {
                writeErr(req.id, t.getClass().getName(), t.getMessage() == null ? t.toString() : t.getMessage());
            }
        }

        // stdin EOF：清理并退出，防止 TS 意外关闭后 Java 进程残留
        client.shutdown();
        System.exit(0);
    }

    private static void dispatch(BapRpcClient client, Req req) throws Exception {
        switch (req.method) {
            case "connect": {
                String uri = str(req.params, 0);
                String user = str(req.params, 1);
                String pwd = str(req.params, 2);
                client.connect(uri, user, pwd);
                CSession session = null;
                try {
                    // 登录会话已置入全局 context；从 service 取不到，改为读取全局上下文保存的会话
                    Object ctx = CRpcAdapter.getGlobalContext(CDaoConst.CTX_SESSION);
                    if (ctx instanceof CSession) session = (CSession) ctx;
                } catch (Throwable ignore) {
                    // GSON 序列化失败不影响 connect 成功回包
                }
                writeOk(req.id, "{\"connected\":true,\"session\":" + GSON.toJson(session) + "}");
                break;
            }
            case "call": {
                String method = str(req.params, 0);
                Object[] args = req.params.length > 1 ? asArray(req.params[1]) : new Object[0];
                Object result = invokeAtomic(client, method, args);
                writeOk(req.id, GSON.toJson(result));
                break;
            }
            case "download": {
                String uuid = str(req.params, 0);
                String destDir = str(req.params, 1);
                String adminTool = str(req.params, 2); // 可空

                CJavaCenterIntf service = client.getService();
                if (service == null) {
                    throw new IllegalStateException("bridge not connected; call connect() first");
                }

                Set<String> folderSet = new HashSet<>();
                for (CJavaFolderDto f : service.getFolders(uuid)) folderSet.add(f.getName());

                File dest = new File(destDir);
                dest.mkdirs();
                File tmpZip = new File(dest, "checkout_temp.zip");
                try {
                    try (FileOutputStream fos = new FileOutputStream(tmpZip)) {
                        Consumer<byte[]> chunk = data -> {
                            try {
                                fos.write(data);
                                fos.flush();
                            } catch (java.io.IOException e) {
                                throw new RuntimeException(e);
                            }
                        };
                        // 临时超时只对"下一次"调用生效，必须紧邻 streamExportProject，
                        // 否则会被上面的 getFolders 消耗、流式调用又回到默认短超时。
                        CRpcAdapter.setTempTimeout(30L * 24 * 60 * 60 * 1000);
                        IProgress<byte[]> prog = CProgressProxy.build(new GuiProgress(), chunk);
                        service.streamExportProject(prog, uuid, folderSet, null);
                    }
                    ZipUtils.unzip(tmpZip.getAbsolutePath(), dest.getAbsolutePath());

                    String at = (adminTool != null && !adminTool.isEmpty()) ? adminTool : null;
                    if (at == null) {
                        try { at = service.getDevAdminTool(); } catch (Throwable ignore) { }
                    }
                    if (at == null || at.isEmpty()) at = "bap.client.BapMainFrame";

                    String xml = String.format("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\n<Development Project=\"%s\" Uri=\"%s\" AdminTool=\"%s\" User=\"%s\" Password=\"%s\" LocalNioPort=\"-1\"/>",
                            uuid, client.getUri(), at, client.getUser(), client.getPwd());
                    Files.write(new File(dest, ".develop").toPath(), xml.getBytes(StandardCharsets.UTF_8));

                    writeOk(req.id, "{\"destDir\":\"" + destDir + "\"}");
                } finally {
                    // 无论成功/取消/异常，都清理临时 zip
                    if (tmpZip.exists()) tmpZip.delete();
                }
                break;
            }
            case "disconnect": {
                client.shutdown();
                writeOk(req.id, "{\"disconnected\":true}");
                break;
            }
            case "ping": {
                writeOk(req.id, Boolean.toString(client.ping()));
                break;
            }
            case "shutdown": {
                client.shutdown();
                writeOk(req.id, "{\"shutdown\":true}");
                OUT.flush();
                System.exit(0);
                break;
            }
            default:
                writeErr(req.id, "unknown_method", req.method);
        }
    }

    /**
     * 反射调用 CJavaCenterIntf 的原子方法（按名字 + 参数数量/类型匹配重载）。
     * 若返回 CSession（login/loginYunStore），同步置入全局 context 供后续调用携带会话。
     */
    private static Object invokeAtomic(BapRpcClient client, String methodName, Object[] args) throws Exception {
        CJavaCenterIntf service = client.getService();
        if (service == null) {
            throw new IllegalStateException("bridge not connected; call connect() first");
        }

        Method method = findMethod(service.getClass(), methodName, args);
        Object[] coerced = coerceArgs(method, args);

        // export* 方法返回大 zip（lib 同步：exportPlatformJars/exportProjectJars/exportPluginJars/
        // exportModelFile/exportOpenSource；发布：exportProject2Plugin），服务端比对/打包耗时可能远超默认
        // 超时（120s）。临时超时只对下一次调用生效，故在此紧邻调用前放宽。
        if (methodName.startsWith("export")) {
            CRpcAdapter.setTempTimeout(30L * 24 * 60 * 60 * 1000);
        }

        Object result = method.invoke(service, coerced);

        // 登录类方法返回 CSession -> 置入全局会话上下文（与生产插件一致），后续 call 自动携带
        if (result instanceof CSession) {
            CRpcAdapter.setGlobalContext(CDaoConst.CTX_SESSION, result);
        }
        return result;
    }

    private static Method findMethod(Class<?> clazz, String name, Object[] args) {
        Method best = null;
        int bestScore = -1;
        for (Method m : clazz.getMethods()) {
            if (!m.getName().equals(name)) continue;
            Class<?>[] ptypes = m.getParameterTypes();
            if (ptypes.length != args.length) continue;
            int score = matchScore(ptypes, args);
            if (score > bestScore) {
                bestScore = score;
                best = m;
            }
        }
        if (best == null) {
            throw new IllegalArgumentException("no method " + name + " with " + args.length + " args");
        }
        return best;
    }

    // 匹配打分：参数类型与 JSON 值兼容性评估，多赋值类型越精确分越高
    private static int matchScore(Class<?>[] ptypes, Object[] args) {
        int score = 0;
        for (int i = 0; i < ptypes.length; i++) {
            Class<?> t = ptypes[i];
            Object a = args[i];
            if (t.isPrimitive() || Number.class.isAssignableFrom(t) || t == String.class) {
                if (isNumberLike(a)) score += 1;
                if (t == String.class && a instanceof String) score += 1;
                if (t == int.class || t == long.class || t == double.class) score += 1;
            } else if (t.isAssignableFrom(a == null ? Object.class : a.getClass())) {
                score += 2;
            }
        }
        return score;
    }

    private static boolean isNumberLike(Object a) {
        return a instanceof Number || a instanceof String || a instanceof Boolean;
    }

    /** 参数强转：把 JSON 元素 coerce 到方法形参类型。 */
    private static Object[] coerceArgs(Method m, Object[] args) {
        Class<?>[] ptypes = m.getParameterTypes();
        Object[] out = new Object[args.length];
        for (int i = 0; i < args.length; i++) {
            out[i] = coerce(ptypes[i], args[i]);
        }
        return out;
    }

    private static Object coerce(Class<?> target, Object arg) {
        if (arg == null) return null;
        if (target.isInstance(arg)) return arg;
        if (target.isPrimitive()) {
            if (target == boolean.class) return Boolean.parseBoolean(String.valueOf(arg));
            if (target == int.class) return ((Number) gsonNumber(arg)).intValue();
            if (target == long.class) return ((Number) gsonNumber(arg)).longValue();
            if (target == double.class) return ((Number) gsonNumber(arg)).doubleValue();
            if (target == float.class) return ((Number) gsonNumber(arg)).floatValue();
            if (target == byte.class) return ((Number) gsonNumber(arg)).byteValue();
            if (target == short.class) return ((Number) gsonNumber(arg)).shortValue();
            if (target == char.class) return String.valueOf(arg).charAt(0);
        }
        // 自定义 bean / 集合 / Map：用 Gson 从 JSON 元素反序列化
        try {
            return GSON.fromJson(GSON.toJson(arg), target);
        } catch (RuntimeException e) {
            return arg;
        }
    }

    private static Object gsonNumber(Object arg) {
        if (arg instanceof Number) return arg;
        return Double.parseDouble(String.valueOf(arg));
    }

    // --- JSON 工具 ---

    private static Object[] asArray(Object o) {
        if (o instanceof Object[]) return (Object[]) o;
        if (o instanceof List) return ((List<?>) o).toArray();
        if (o == null) return new Object[0];
        return new Object[]{o};
    }

    private static String str(Object[] arr, int idx) {
        return arr != null && idx < arr.length && arr[idx] != null ? String.valueOf(arr[idx]) : null;
    }

    private static void writeOk(long id, String resultJson) {
        synchronized (OUT_LOCK) {
            OUT.println("{\"id\":" + id + ",\"ok\":true,\"result\":" + resultJson + "}");
        }
    }

    private static void writeErr(long id, String name, String message) {
        synchronized (OUT_LOCK) {
            String msg = message == null ? "" : message.replace("\"", "\\\"");
            OUT.println("{\"id\":" + id + ",\"ok\":false,\"error\":{\"name\":\"" + name + "\",\"message\":\"" + msg + "\"}}");
        }
    }

    /** 向 TS 推送下载进度帧（无 id，供 BridgeProcess 识别为 progress 事件）。 */
    private static void sendProgress(int percent, String message) {
        synchronized (OUT_LOCK) {
            String msg = message == null ? "" : message;
            OUT.println("{\"progress\":{\"percent\":" + percent + ",\"message\":" + GSON.toJson(msg) + "}}");
        }
    }

    /**
     * 进度/回调控制器：CProgressProxy 会把服务器的 setMaximum/getMaximum/sendProcess 委托到这里。
     * 我们记录服务器设置的进度范围并转发进度给 TS；getMaximum 返回真实值，避免服务器因范围 0 提前终止流。
     */
    static final class GuiProgress implements ProgressControllerFEIntf {
        private int max = 100;
        private int min = 0;

        public void setMaximum(int v) { this.max = v; }
        public void setMinimum(int v) { this.min = v; }
        public int getMaximum() { return max; }
        public int getMinimum() { return min; }
        public void reset() { }
        public void sendProcess(int percent, String message, boolean b) { sendProgress(percent, message); }
        public void sendProcess(int percent, String message, boolean b, Object o) { sendProgress(percent, message); }
        public void setMessage(String m, boolean b) { }
        public void sendStopProcess() { }
        public boolean isCanceled() { return false; }
        public boolean isTerminated() { return false; }
        public void showMessageDialog(String a, String b, int c) { }
        public void showMessageDialog(String a, String b) { }
        public int showConfirmDialog(String a, String b, int c) { return 0; }
        public int showConfirmDialog(String a, String b, int c, int d) { return 0; }
    }

    private static void redirectSystemOutToStderr() {
        // 第三方（tcmcat/netty）可能直接写 System.out，污染 stdout 的 JSON 协议帧。
        // OUT 已在类加载时捕获原始 stdout，因此这里把 System.out 重定向到 stderr 是安全的。
        System.setOut(new PrintStream(System.err, true));
    }

    private static void quietJdkLogging() {
        java.util.logging.Logger root = java.util.logging.Logger.getLogger("");
        root.setLevel(Level.WARNING);
        for (java.util.logging.Handler h : root.getHandlers()) h.setLevel(Level.WARNING);
    }
}
