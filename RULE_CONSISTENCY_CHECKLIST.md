# Blood on the Clocktower 规则一致性补齐清单

本文聚焦当前服务端实现与 Trouble Brewing 官方规则的差距，按优先级拆解为可执行任务。

## P0（先补，直接影响胜负公平）

- [ ] Baron 生效：开局外来者数量 +2（并联动基础人数配比）
  - 现状：`assignRoles()` 按固定人数配比发身份，未根据 `baron` 动态调整。
  - 验收：包含 `baron` 的对局，外来者数量正确变化，且总人数、阵营人数保持一致。

- [ ] Spy 注册规则：对“被视为善良/镇民”信息位可被识别为镇民
  - 现状：`computeChefPairs()`、`computeEmpathCount()`、`formatUndertakerInfoForSeat()` 等主要看真实阵营/身份，缺少注册层。
  - 验收：按角色文本，Spy 在相关检测与信息位中可按注册结果生效。

- [ ] Scarlet Woman 继承条件精确化（存活人数阈值）
  - 现状：当前以“首个存活爪牙继承”简化处理，未实现猩红女巫条件触发。
  - 验收：仅当恶魔死亡且满足人数条件时，`scarlet_woman` 继承恶魔；否则不继承。

- [ ] Mayor 夜晚改刀能力
  - 现状：`runDemonKill()` 未处理 Mayor 被攻击时改刀逻辑。
  - 验收：Mayor 满足条件被攻击时，可按规则改为其他目标死亡，且不破坏保护/士兵等优先级。

- [ ] Saint 被处决即时失败
  - 现状：`execute()` 仅按恶魔生存与存活人数结算胜负。
  - 验收：Saint 被处决后善良立即失败，不进入常规继续流程。

## P1（高优先，影响信息推理质量）

- [ ] Recluse 注册为邪恶/恶魔的可裁定机制
  - 现状：信息位与检测位多使用真实身份，缺少“可被当作邪恶/恶魔”接口。
  - 验收：Chef/Empath/Fortune Teller/Investigator 等交互可通过统一注册层控制。

- [ ] Fortune Teller 红鲱鱼（Red Herring）
  - 现状：`formatFortuneTellerResult()` 仅检测目标中是否真实恶魔。
  - 验收：每局固定红鲱鱼，且占卜师结果符合“恶魔或红鲱鱼为是”。

- [ ] Butler 白天投票约束
  - 现状：`vote()` 未限制 Butler 必须跟随 Master 投票。
  - 验收：Butler 违反约束时投票无效或被拦截，并有可解释反馈。

- [ ] Ravenkeeper 结算改为“自选目标并得知其身份”
  - 现状：`resolveRavenkeeperNightInfo()` 采用“告知行凶者身份”的简化规则。
  - 验收：夜死后唤醒守鸦人，选择目标，收到目标真实身份（中毒/醉酒可失真）。

- [ ] Virgin 触发条件补全“提名者是否为镇民（含注册层）”
  - 现状：仅按真实 `type === townsfolk` 判断，未纳入注册与例外。
  - 验收：触发判定可通过统一“注册身份”接口扩展，和其他信息位一致。

## P2（中优先，体验与可维护性）

- [ ] 统一“注册/中毒/醉酒”判定层（建议抽象 `registration` 模块）
  - 目标：避免每个角色函数手写特判，减少规则漂移。
  - 验收：Chef/Empath/Fortune/Undertaker/Investigator 等共享同一套查询接口。

- [ ] 夜序引擎增加“角色能力优先级图”
  - 目标：明确投毒、保护、杀人、改刀、信息结算的先后，避免回归。
  - 验收：关键冲突用例有自动化测试，结果稳定。

- [ ] 回归测试矩阵（5/7/10/12 人局）
  - 目标：覆盖角色组合、白天提名投票、夜晚冲突与胜负条件。
  - 验收：新增测试集可稳定复现并防止规则倒退。

## 建议执行顺序

1. Baron / Saint / Scarlet Woman / Mayor（先修胜负与盘面）
2. Spy / Recluse / Fortune Teller 红鲱鱼（再修信息质量）
3. Butler / Ravenkeeper / Virgin 注册层（补齐角色交互）
4. 抽象统一注册层 + 回归测试矩阵（固化长期维护能力）
