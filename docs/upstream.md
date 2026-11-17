# 来源约定

## 产品交换范围

来源是 C3D 的 Intel processor type=84 子集，支持 SCALE 正数的 int16 点坐标与负数的 float32 点坐标；其他 processor 明确报告不支持。头内 first/last frame 含端点，DATA_START 按 512 字节块，参数记录按名称和所属组解释，offset-to-next 从其 offset 字段自身起算，零终止。POINT:USED/SCALE/RATE/LABELS、ANALOG:USED/RATE/GEN_SCALE/SCALE/OFFSET/LABELS 是支持范围，组顺序与记录顺序不承担语义。每个点帧中的模拟值按子帧、通道排列，ANALOG rate 与 point rate 应给出整倍数并与每帧模拟值数相容。标量/每通道比例按照实参维数校验，物理模拟值为 (raw-OFFSET)*SCALE*GEN_SCALE。浮点点 residual<0 标记无效但不抹除原始值；整数点保留打包残差/相机字原值，不要求解码相机编号。

## 产品联合接收语义

`POST /recordings` 一次领取同一件原件中的点帧与模拟子帧，参数段经名称/组名解析得到通道身份（LABELS）、比例（GEN_SCALE、逐通道或标量 SCALE）、偏移（逐通道或标量 OFFSET）与采样关系（RATE 整倍数、头内每帧值数），不假设固定组顺序、记录顺序或模拟字段偏移。每条点坐标与模拟样本在解释结果中保留 `raw` 原始读数、物理换算值与 `location`（原帧号、子帧号、全局样本序号、原件字节偏移），参数本身保留 `parameterSources` 字节位置，保证可回溯到原帧和原始读数。

不相容情形整体拒收（HTTP 422，不写任何记录），响应体含稳定 `error` 代码与 `details`：

- `c3d_rate_relation`：ANALOG:RATE 与 POINT:RATE 不是整倍数；
- `c3d_header_mismatch`：头内点数/每帧模拟值数/子帧数与参数声明冲突（`/recordings/incompatible` 即此情形，头声明 3 而参数需要 4）；
- `c3d_data_short`：有效载荷字节不足以容纳声明的全部点帧与模拟子帧（`/recordings/truncated` 即此情形），明细给出所需/可用字节与期望模拟样本数；
- `c3d_parameter_shape`/`c3d_parameter_type`/`c3d_parameter_missing`：实参维数、类型或必需参数不符合声明。

产品不会通过截短数组、丢弃子帧或复用末值把两套时序凑齐；通用收件 `POST /intakes` 与联合接收使用相互独立的持久索引，原件对象共用内容寻址存储。

## 当前来源路由

- `/primary`：application/octet-stream
- `/recordings/with-analog`：application/octet-stream
- `/recordings/incompatible`：application/octet-stream
- `/recordings/truncated`：application/octet-stream

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://www.c3d.org/HTML/default.htm

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
