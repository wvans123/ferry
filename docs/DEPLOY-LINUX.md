# 服务端放在 Linux 云服务器上

适合要一台一直在线的服务端，或者要用 Claude / OpenAI（这两家不服务中国大陆和香港，服务器要放在它们支持的地区）。

```
工作电脑 ──HTTPS──> ferry.你的域名（Caddy 自动证书）──> 127.0.0.1:8787 Ferry 服务端 ──> 模型 API
```

## 一、安装

```bash
sudo apt install -y pipx caddy        # 其他发行版换成对应的包管理器
sudo useradd --system --create-home --home-dir /var/lib/ferry ferry
sudo -u ferry pipx install "git+https://github.com/wvans123/ferry.git#subdirectory=server"
```

## 二、开机自动运行（systemd）

```bash
sudo curl -fsSL -o /etc/systemd/system/ferry-server.service https://raw.githubusercontent.com/wvans123/ferry/main/deploy/ferry-server.service
sudo systemctl enable --now ferry-server
sudo journalctl -u ferry-server -n 20      # 能看到令牌位置和管理页地址
sudo cat /var/lib/ferry/server/token        # 工作电脑登录用的令牌
```

## 三、HTTPS（Caddy）

域名先解析到这台服务器，然后：

```bash
sudo curl -fsSL -o /etc/caddy/Caddyfile https://raw.githubusercontent.com/wvans123/ferry/main/deploy/Caddyfile
sudo sed -i 's/ferry.example.com/ferry.你的域名/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl https://ferry.你的域名/health
```

没有公网 IP、或者不想开 443 端口，可以改用 Cloudflare Tunnel，步骤和 [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md#二给它一个域名cloudflare-tunnel10-分钟) 一样（安装命令选 Linux）。

## 四、管理页（只能从本机打开）

管理页只接受来自服务器本机的请求。从你自己的电脑用 SSH 隧道打开：

```bash
ssh -L 8787:127.0.0.1:8787 你的服务器
```

然后在自己电脑的浏览器里打开 `journalctl` 里显示的管理页地址（`http://127.0.0.1:8787/admin?key=...`）。在"服务商和模型"里填 API Key，在"设置"里填外网地址。

## 五、工作电脑

```bat
ferry login https://ferry.你的域名 你的令牌
ferry doctor
```

## 升级

```bash
sudo -u ferry pipx upgrade ferry-server && sudo systemctl restart ferry-server
```
