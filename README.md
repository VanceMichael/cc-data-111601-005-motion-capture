# motion-capture

动作记录中点帧与模拟子帧的联合接收相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

C3D 点帧与模拟子帧可按一次采集联合领取、解释和登记：参数段按名称与所属组识别通道身份、比例、偏移和采样关系，支持 SCALE 正数的 int16 与负数的 float32 两种存储，组/记录顺序和模拟偏移均按参数链动态解释，不依赖固定布局。浮点原件残差为负的点保留无效标志与原始读数，整数原件保留打包残差/相机字。每条点与模拟样本都带有原帧号、子帧号和原件字节偏移，可回溯原始读数。参数声明与有效载荷不相容（速率非整倍数、每帧值数不符、载荷截断等）时整体拒收并返回结构化错误码与明细，绝不截短数组凑齐时序。

`src/c3d.mjs` 提供完整联合读取契约，`src/reader.mjs` 保留既有单件读取入口；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 分别保存通用收件摘要与联合接收记录，原件共用对象存储。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一件资料、读取已保存结果，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- POST /recordings，JSON 为 {"path":"/recordings/with-analog"}：联合领取一次采集的点帧与模拟子帧，成功返回 201 与解释结果；参数声明与有效载荷不相容时返回 422，响应含 `error` 代码、`message` 与 `details` 明细，且不写入任何记录。
- GET /records：持久通用收件目录；同 source URL、同摘要重领返回原 id。
- GET /recordings：联合接收记录目录，与通用收件索引相互独立；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。

GET 请求均为只读，写操作只接受 POST。通用收件记录只代表该单件 raw 对象已保存；联合接收记录代表点与模拟两套时序已按参数声明完整对齐。

## 拒收代码

联合领取的 422 响应使用稳定代码：`c3d_header`、`c3d_parameter_block`、`c3d_processor_unsupported`（非 Intel type=84）、`c3d_parameter_section`、`c3d_parameter_record`、`c3d_parameter_chain`、`c3d_parameter_type`、`c3d_parameter_shape`（含标量/逐通道维数不相容）、`c3d_parameter_missing`、`c3d_group_missing`、`c3d_header_mismatch`（头与参数声明冲突，含每帧模拟值数不符）、`c3d_rate_relation`（ANALOG:RATE 与 POINT:RATE 非整倍数）、`c3d_data_short`（有效载荷容量不足，明细给出所需与可用字节及期望模拟样本数）。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖联合读取器（int16/float32 两种存储、参数乱序、标量/逐通道比例、无效点、维数与速率不相容、载荷截断、processor 拒绝、缺参数）、畸形输入、真实 HTTP 联合领取、原件一致性、持久重开、拒收无副作用、同源边界和范围响应；领域读取行为在 test/domain.test.mjs 与 test/joint-recording.test.mjs，合成原件构造器在 test/c3d-builder.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t motion-capture:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
