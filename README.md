# CRADOS

一个浏览器原生运行环境实验：使用 JavaScript 引擎执行应用，并通过权限代理提供受控系统服务。

## 部署

这是纯静态网站，无需构建步骤。

1. 打开仓库的 Settings → Pages。
2. 选择 Deploy from a branch。
3. 选择 `clear-repo-test` 分支和 `/(root)` 目录。
4. 保存后等待 GitHub Pages 部署完成。

## 功能

- 沙箱 iframe 中执行 JavaScript
- Guest 控制台桥接
- 可授权的 HTTPS 请求代理
- 基于 IndexedDB 的虚拟文件
- 本地权限设置

## 安全边界

该项目是原型，不是经过安全认证的隔离环境。Guest 脚本仍可能耗尽 CPU 或内存。网络请求受浏览器 CORS 和混合内容策略限制。不要在虚拟文件中保存机密信息。
