# 服务端放在家里的 Mac 上，工作电脑通过域名连过去

```
工作电脑 (Windows)                Cloudflare                     家里的 Mac
ferry ──HTTPS──> ferry.你的域名 ──(Cloudflare Tunnel)──> cloudflared ──> ferry-server (127.0.0.1:8787) ──> 模型 API
```

- **不用自己弄证书**：工作电脑到 Cloudflare 这一段的 HTTPS 证书由 Cloudflare 自动提供。
- **不用公网 IP、不用路由器端口映射**：Mac 上的 cloudflared 主动连到 Cloudflare，所以直接访问家里 IP 不通、访问域名却能通。
- `ferry-server` 只监听 Mac 本机的 127.0.0.1，局域网里的其他设备也连不到它，只能从隧道进来。

下面以 `ferry.2012wtlab.com` 为例，换成你自己想用的子域名。

## 一、Mac：装服务端（5 分钟）

在"终端"里：

```bash
brew install pipx cloudflared
pipx ensurepath
pipx install "git+https://github.com/wvans123/ferry.git#subdirectory=server"
```

关掉终端重新打开，设置 Key（用 DeepSeek 为例；换 Claude 就写 `ANTHROPIC_API_KEY`）：

```bash
echo 'export DEEPSEEK_API_KEY=sk-你的key' >> ~/.zshrc
source ~/.zshrc
```

先手动跑一次看看：

```bash
ferry-server
```

看到 `Ferry server ... on http://127.0.0.1:8787` 和 `DEEPSEEK_API_KEY found` 就对了。按 Ctrl+C 停掉，然后让它开机自动运行：

```bash
curl -fsSLO https://raw.githubusercontent.com/wvans123/ferry/main/deploy/mac/autostart.sh
sh autostart.sh
```

最后一行会显示令牌，记下来，工作电脑登录时要用。以后忘了：`cat ~/.ferry-server/token`。

**Mac 不能睡眠**：系统设置 → 电池（或"节能"）→ 打开"接电源时，显示器关闭后防止自动进入睡眠"。Mac 睡着了，工作电脑就连不上。

更新服务端：`pipx upgrade ferry-server`，然后 `sh autostart.sh` 重新加载。

## 二、Cloudflare：给服务端一个域名（5 分钟）

你访问 `nef.2012wtlab.com` 能打开，说明你已经有一条 Cloudflare Tunnel。在同一条隧道上加一个地址就行：

1. 打开 Cloudflare 控制台 → **Zero Trust** → **Networks** → **Tunnels**，点你现在用的那条隧道 → **Edit**。
2. **Public Hostname** → **Add a public hostname**（新版界面里可能叫 **Published application routes** → **Add**）：
   - Subdomain：`ferry`
   - Domain：`2012wtlab.com`
   - Service：类型 `HTTP`，URL `127.0.0.1:8787`（不要写 localhost，有的机器会解析成 IPv6 地址而连不上）
3. 保存。

如果那条隧道不在这台 Mac 上运行，就新建一条：**Create a tunnel** → 选 Cloudflared → 起个名字 → 按页面提示在 Mac 上复制运行那条 `sudo cloudflared service install ...` 命令（装好后开机自动运行），再按上面第 2 步加地址。

在 Mac 上验证：

```bash
curl https://ferry.2012wtlab.com/health
```

返回 `{"ok":true,...}` 就通了。

### 关于那个 Cloudflare 登录页

访问 `nef` 时出现的 Cloudflare 登录页，是 Zero Trust 的 **Access**（访问控制）。`ferry` 是命令行程序，没法在浏览器里登录，所以二选一：

- **简单**：不给 `ferry.2012wtlab.com` 配 Access。Ferry 自己有令牌，没有令牌的请求会被拒绝（HTTP 401）。如果你的 Access 规则覆盖了整个域名（`*.2012wtlab.com`），要把 `ferry` 这个子域名排除掉。
- **多一层保护**：保留 Access，给 Ferry 发一个"服务令牌"。Zero Trust → **Access** → **Service Auth** → **Service Tokens** → **Create**（新版界面里可能在 **Access controls** → **Service credentials**），记下 Client ID 和 Client Secret；在 `ferry` 对应的 Access 应用里加一条策略，Action 选 **Service Auth**，Include 选这个令牌。工作电脑登录时带上它（见下一节）。

## 三、工作电脑：连过去

1. 从 [Releases](https://github.com/wvans123/ferry/releases/latest) 下载 `ferry-windows-x.y.z.zip`，解压，在 cmd 里进入解压出的文件夹，只装客户端：

   ```bat
   node client\bin\ferry.mjs install --client-only
   ```

2. 重新打开 cmd，登录：

   ```bat
   ferry login https://ferry.2012wtlab.com 你的令牌
   ```

   用了 Access 服务令牌的话：

   ```bat
   ferry login https://ferry.2012wtlab.com 你的令牌 --header "CF-Access-Client-Id: xxx.access" --header "CF-Access-Client-Secret: yyy"
   ```

3. 检查：

   ```bat
   ferry doctor
   ```

   全是 OK 就可以在项目文件夹里运行 `ferry` 了。

| doctor 里看到 | 原因和处理 |
|---|---|
| `a Cloudflare Access login page answered` | Access 挡住了，按上面"关于那个 Cloudflare 登录页"处理 |
| `cannot reach the server` | 浏览器能打开但 ferry 连不上：浏览器走了公司代理。查代理地址（浏览器或 Windows 的代理设置），`setx HTTPS_PROXY http://代理地址:端口`，重开 cmd |
| `unable to get local issuer certificate` 或 `self-signed certificate` | 公司代理会解开 HTTPS 再用公司自己的证书重新加密。把公司根证书导出成 `.pem`（问 IT，或从浏览器证书详情里导出），`setx NODE_EXTRA_CA_CERTS C:\路径\公司根证书.pem`，重开 cmd |
| `HTTP 502` 或 `530` | Cloudflare 连不到 Mac：Mac 睡眠了、cloudflared 或 ferry-server 没在运行。在 Mac 上 `curl http://127.0.0.1:8787/health` 查 |

## 速度

Ferry 传的都是文字，而且每轮只传新增的部分，流量很小。慢主要来自**来回的次数**：每一轮 agent 循环是两次请求（同步新消息、调用模型），每次都要经过 Cloudflare。免费版 Cloudflare 在中国大陆没有节点，一次往返通常要几百毫秒。

`ferry doctor` 里的 `server reachable in N ms` 就是一次往返的时间：

- 几百毫秒：每轮多 1 秒左右，相比模型生成回答的几秒到几十秒，影响不大；
- 超过 1 秒：可以把"同步"和"调用模型"合并成一次请求，每轮少一次往返（Ferry 可以做，告诉我数字再决定）；
- 再快只能换线路：国内云服务器做中转，或者付费的加速服务。

另外，Cloudflare 要求服务端在 100 秒内开始回应，否则返回 524。Ferry 是边生成边返回的，模型开始输出后就不受这个限制；只有模型"想"了超过 100 秒还没输出第一个字时才会遇到。
