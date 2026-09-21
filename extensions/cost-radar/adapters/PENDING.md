# 待收录模型定价（PENDING）

> 供应商官方定价核对失败或部分型号无法核对时记录于此，**不注册进 registry**（未收录路径天然生效：仅计 token、金额不计、面板提示等收录）。核对成功才收录。
> 核对日期：2026-09-07（任务 4 执行期）。

| family | 型号范围 | 官方 URL | 失败原因 | 待补：价格行 + 缓存语义 |
|--------|----------|----------|----------|--------------------------|
| glm | 现役 GLM-5.3 / GLM-5.3-Flash / GLM-5.2 / GLM-5.1 / GLM-5 / GLM-5-Turbo（及 4.x 系）；免费型号 glm-4.7-flash / glm-4.5-flash 等 | https://open.bigmodel.cn/pricing（官方价格页）；https://docs.bigmodel.cn/cn/guide/start/model-overview（静态 docs，模型页如 /cn/guide/models/text/glm-5.3 无价格） | 官方价格页为 Vue SPA（JS 渲染，HTML 仅样式壳），价格经需登录的业务 API（static.bigmodel.cn/wd-paas-front js 内 /biz/model/* 端点）下发，curl 无法核对；docs.bigmodel.cn 模型页/概览只引价格页、不含绝对价格（glm-5.3-flash 页仅有「= GLM-5.3 的 1/10（限时 1/20）」相对表述）；国际站 z.ai/pricing 亦为 404 SPA 壳。免费模型在 docs 标注 ¥0，但旗舰付费行全部无法核对 → 整族不收录 | 价格行（每款模型输入/输出 ¥ 或 USD 单价）+ 缓存命中/写费语义；免费行（glm-4.7-flash 等 ¥0）可随旗舰行一并收录 |
