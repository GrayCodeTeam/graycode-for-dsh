# @graycode/dsh

GrayCode 能力的 DSH 组合包（bundle）。

本包仅声明 `dsh.bundle.patch`（`cordis.patch.yml`），在 DSH profile 的 base/web 层之上
增量插入 GrayCode 插件行：

```yaml
- insert:
    - id: graycode
      name: '@graycode/dsh-plugin'
    - id: graycode-client
      name: '@graycode/dsh-client'
```

安装（以本地 tarball 为例）：

```sh
dsh plugin --profile graycode add ./graycode-dsh-0.1.0.tgz
dsh --profile graycode
```

- 版本锁定：DSH `0.1.0-rc.6`（见仓库根 `docs/ADR-0001.md`）。
- 组合层默认值在插件 Schemastery schema 中；本层只钉 id，不复制 DSH 配置。
