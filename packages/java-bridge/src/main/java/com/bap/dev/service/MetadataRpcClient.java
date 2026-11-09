package com.bap.dev.service;

import cell.panelxpro.metadata.IPanelMetadataService;
import com.leavay.nio.crpc.CRpcAdapter;
import com.leavay.nio.crpc.CRpcClientWrapper;

import java.net.URI;
import java.util.logging.Logger;

/**
 * MetadataDomain RPC 客户端（复刻生产 IDEA 插件 com.bap.dev.service.MetadataRpcClient）。
 *
 * <p>复用 {@link CRpcAdapter#getInstance()} 与 {@link BapRpcClient} 登录后写入的全局会话，
 * 本身<b>不登录</b>；桥内调用前必须先完成主连接 connect。
 *
 * <p>与 IDEA 版的差异：IntelliJ 的 com.intellij.openapi.diagnostic.Logger 不在桥的 classpath，
 * 改用 java.util.logging.Logger（与 BapRpcClient 一致）。
 */
public class MetadataRpcClient {
    private static final Logger LOG = Logger.getLogger(MetadataRpcClient.class.getName());

    private CRpcClientWrapper<IPanelMetadataService> rpcWrapper;
    private String currentUri;
    private String currentUser;
    private String currentPwd;

    public void connect(String uri, String user, String pwd) throws Exception {
        if (isConnected()) {
            shutdown();
        }

        LOG.info("MetadataRpcClient: Connecting to " + uri + "...");

        // JDK 8 下匿名子类不能用钻石写法，显式写 <IPanelMetadataService>；
        // CRpcClientWrapper 是抽象类，必须实现 getAdapter()。
        rpcWrapper = new CRpcClientWrapper<IPanelMetadataService>(
                IPanelMetadataService.class, URI.create(uri)) {
            @Override
            public CRpcAdapter getAdapter() {
                return CRpcAdapter.getInstance();
            }
        };

        this.currentUri = uri;
        this.currentUser = user;
        this.currentPwd = pwd;

        LOG.info("MetadataRpcClient: Connected to " + uri);
    }

    public IPanelMetadataService getService() {
        if (rpcWrapper == null) {
            throw new IllegalStateException("metadata RPC client is not connected; call connect() first");
        }
        return rpcWrapper.getIntf(true);
    }

    public void shutdown() {
        if (rpcWrapper != null) {
            try {
                rpcWrapper.shutdown();
            } catch (Exception e) {
                LOG.warning("metadata shutdown failed: " + e);
            }
            rpcWrapper = null;
        }
        this.currentUri = null;
        this.currentUser = null;
        this.currentPwd = null;
    }

    public boolean isConnected() {
        return rpcWrapper != null;
    }

    public boolean ping() {
        if (rpcWrapper == null) {
            return false;
        }
        try {
            // CRpcClientWrapper.ping() 只对实现 Pingable 的接口真正发包；IPanelMetadataService
            // 未实现 Pingable，必须直接调用服务自身的 ping()，否则会永远返回 true。
            getService().ping();
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    // --- Getters ---

    public String getUri() { return currentUri; }
    public String getUser() { return currentUser; }
    public String getPwd() { return currentPwd; }
}
