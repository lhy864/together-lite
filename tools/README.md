桌面安装包已包含 Caddy，普通用户不需要操作此文件夹。

源码开发与打包时，将官方 Windows x64 Caddy 二进制放在此目录，命名为 caddy.exe，并保留 CADDY-LICENSE。
桌面版在图形化设置填写 HTTPS 域名后启动 Caddy；旧脚本模式在 config.local.json 的 publicUrl 设置为 HTTPS 时启动。
局域网使用不需要启用 Caddy。
