# 服务端放在一台 Windows 电脑上（比如家里的电脑），工作电脑通过域名连过来

```
工作电脑 ──HTTPS──> ferry.你的域名（Cloudflare）──隧道──> 家里的 Windows 电脑：Ferry 服务端 127.0.0.1:8787 ──> 模型 API
```

- 不用公网 IP、不用路由器端口映射、不用自己弄证书：电脑上的 cloudflared 主动连到 Cloudflare，HTTPS 由 Cloudflare 提供。
- 服务端只监听本机 127.0.0.1；管理页只能在这台电脑上打开。
- 这台电脑要开着、不睡眠，工作电脑才连得上。

## 一、装服务端（10 分钟）

需要 Python 3.11–3.14（python.org 安装时勾选 "Add python.exe to PATH"）。

1. 从 [Releases](https://github.com/wvans123/ferry/releases/latest) 下载 `ferry-windows-x.y.z.zip`，解压。
2. 想把数据放到 D 盘的话，先设好位置（可选，不设就放在 `%USERPROFILE%\.ferry-server`）：
   ```bat
   setx FERRY_SERVER_HOME D:\ferry\server
   ```
   重新打开 cmd。
3. 安装（离线，用安装包里带的 wheel）：
   ```bat
   cd /d 解压出的文件夹
   python -m pip install --no-index --find-links wheels ferry-server
   ```
4. 启动并打开管理页：
   ```bat
   pythonw -m ferry_server --ui
   ```
   服务端在后台运行（没有黑窗口），浏览器打开管理页。想要桌面图标：新建快捷方式，目标填 `pythonw -m ferry_server --ui`，名字叫 Ferry Server。
5. 管理页 → **服务商和模型** → 添加服务商 → 选 DeepSeek（或别家）→ 只填 API Key → 勾选模型 → 保存并测试。
6. 管理页 → **设置**：
   - 填"外网地址"，比如 `https://ferry.example.com`，概览页的登录命令会用它；
   - 打开"开机自动启动"。

## 二、给它一个域名：Cloudflare Tunnel（10 分钟）

需要一个托管在 Cloudflare 上的域名（免费套餐即可）。

1. Cloudflare 控制台 → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** → Cloudflared → 起个名字。
2. 页面上选 Windows，复制它给的安装命令，在**管理员** cmd 里运行。这会把 cloudflared 装成 Windows 服务，开机自动连。已经有隧道的话跳过这一步，用现有的。
3. 隧道的 **Public Hostname**（新版叫 **Published application routes**）→ **Add**：
   - Subdomain：`ferry`，Domain：你的域名；
   - Service：`HTTP`，URL：`127.0.0.1:8787`（写 127.0.0.1，不要写 localhost）。
4. 在这台电脑上验证：浏览器打开 `https://ferry.你的域名/health`，看到 `{"ok":true,...}` 就通了。

不要给这个地址加 Cloudflare Access 登录页：命令行没法在网页上登录，Ferry 自己的令牌已经挡住了没有令牌的请求。一定要加的话，见 [DEPLOY-MAC.md](DEPLOY-MAC.md#关于那个-cloudflare-登录页) 里"服务令牌"的做法。

## 三、工作电脑连过来

管理页 → **概览** → "登录命令" → **复制**，到工作电脑的 cmd 里粘贴运行，然后 `ferry doctor`。工作电脑怎么装 Ferry，见 [README](../README.md#工作电脑装客户端)。

## 维护

| 要做的事 | 怎么做 |
|---|---|
| 看状态、流量、调用记录 | 双击 Ferry Server 图标 |
| 升级 | 下载新的 zip，解压，`python -m pip install --no-index --find-links wheels --upgrade ferry-server`，在管理页"停止"后再双击图标 |
| 令牌泄露了 | 管理页 → 设置 → 换一个新令牌，工作电脑重新 `ferry login` |
| 工作电脑报 502 / 530 | 这台电脑睡眠了，或服务端、cloudflared 没在运行 |
| 数据在哪 | `FERRY_SERVER_HOME`（默认 `%USERPROFILE%\.ferry-server`）：`token`、`secrets.toml`（API Key）、`models.toml`、`server.toml`、`rules\`、`data\`（会话、日志） |
