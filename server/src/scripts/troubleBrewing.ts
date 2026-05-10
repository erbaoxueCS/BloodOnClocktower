// ============================================================
// 暗流涌动 (Trouble Brewing) 剧本定义
// infoSource 标注：
//   'rule'        = 信息由引擎确定性计算（如厨师：相邻邪恶数）
//   'storyteller' = 信息由说书人选/裁量（如洗衣妇：选谁+指什么身份）
//   'none'        = 角色无信息获取能力
// ============================================================

import type { ScriptDef } from '../engine/types.js';

export const troubleBrewing: ScriptDef = {
  id: 'trouble_brewing',
  name: 'Trouble Brewing',
  nameZh: '暗流涌动',
  minPlayers: 5,
  maxPlayers: 15,

  // 首夜顺序（12 步）
  firstNightOrder: [
    'demon_info',
    'minion_info',
    'washerwoman',
    'librarian',
    'investigator',
    'chef',
    'empath',
    'fortune_teller',
    'monk',
    'spy',
    'imp',
    'poisoner',
  ],

  // 后续夜晚顺序
  otherNightOrder: [
    'poisoner',
    'spy',
    'monk',
    'fortune_teller',
    'empath',
    'imp',
    'undertaker',
    'ravenkeeper',
  ],

  characters: [
    // ============ 镇民 (Townsfolk) ============
    {
      id: 'washerwoman',
      name: 'Washerwoman',
      nameZh: '洗衣妇',
      alignment: 'good',
      type: 'townsfolk',
      ability: 'You start knowing that 1 of 2 players is a particular Townsfolk.',
      abilityZh: '你得知两名玩家中有一人是某个特定的镇民身份。',
      infoSource: 'storyteller',  // 说书人选择哪两人+指哪个镇民身份
      firstNightOnly: true,
    },
    {
      id: 'librarian',
      name: 'Librarian',
      nameZh: '图书管理员',
      alignment: 'good',
      type: 'townsfolk',
      ability: 'You start knowing that 1 of 2 players is a particular Outsider (or that there are no Outsiders).',
      abilityZh: '你得知两名玩家中有一人是某个特定的外来者（或得知本局无外来者）。',
      infoSource: 'storyteller',
      firstNightOnly: true,
    },
    {
      id: 'investigator',
      name: 'Investigator',
      nameZh: '调查员',
      alignment: 'good',
      type: 'townsfolk',
      ability: 'You start knowing that 1 of 2 players is a particular Minion.',
      abilityZh: '你得知两名玩家中有一人是某个特定的爪牙身份。',
      infoSource: 'storyteller',
      firstNightOnly: true,
    },
    {
      id: 'chef',
      name: 'Chef',
      nameZh: '厨师',
      alignment: 'good',
      type: 'townsfolk',
      ability: 'You start knowing how many pairs of evil players there are.',
      abilityZh: '你得知有多少对相邻的邪恶玩家。',
      infoSource: 'rule',  // 确定性计算：遍历相邻座位统计邪恶配对
      firstNightOnly: true,
    },
    {
      id: 'empath',
      name: 'Empath',
      nameZh: '共情者',
      alignment: 'good',
      type: 'townsfolk',
      ability: 'Each night, you learn how many of your 2 alive neighbors are evil.',
      abilityZh: '每夜你得知你两名存活邻居中有多少名邪恶玩家。',
      infoSource: 'rule',  // 确定性计算：检查左右存活邻居的角色阵营
    },
    {
      id: 'fortune_teller',
      name: 'Fortune Teller',
      nameZh: '占卜师',
      alignment: 'good',
      type: 'townsfolk',
      ability: 'Each night, choose 2 players: you learn if either is a Demon. There is a good player that always registers as the Demon to you.',
      abilityZh: '每夜选择两名玩家：你得知其中是否有一名恶魔。有一名善良玩家始终被你检测为恶魔（说书人指定"红鲱鱼"）。',
      infoSource: 'rule',  // 引擎计算是否有恶魔（含红鲱鱼说书人指定项）
      requiresPlayerChoice: true,
      pickCount: 2,
    },
    {
      id: 'undertaker',
      name: 'Undertaker',
      nameZh: '掘墓人',
      alignment: 'good',
      type: 'townsfolk',
      ability: 'Each night*, you learn which character was executed today.',
      abilityZh: '每夜*你得知今天被处决玩家的角色身份。',
      infoSource: 'rule',  // 确定性：被处决玩家的真实角色
      firstNightOnly: false,
    },
    {
      id: 'monk',
      name: 'Monk',
      nameZh: '僧侣',
      alignment: 'good',
      type: 'townsfolk',
      ability: 'Each night*, choose a player (not yourself): they are safe from the Demon tonight.',
      abilityZh: '每夜*选择一名玩家（不能选自己）：该玩家今夜免疫恶魔的杀害。',
      infoSource: 'none',
      requiresPlayerChoice: true,
      pickCount: 1,
    },
    {
      id: 'ravenkeeper',
      name: 'Ravenkeeper',
      nameZh: '守鸦人',
      alignment: 'good',
      type: 'townsfolk',
      ability: 'If you die at night, you learn which player killed you.',
      abilityZh: '若你在夜晚死亡，你得知杀害你的玩家是谁。',
      infoSource: 'rule',  // 确定性：nightKillAttackerByVictim
      firstNightOnly: false,
    },
    {
      id: 'virgin',
      name: 'Virgin',
      nameZh: '处女',
      alignment: 'good',
      type: 'townsfolk',
      ability: 'The 1st time you are nominated, if the nominator is a Townsfolk, they are executed immediately.',
      abilityZh: '你首次被提名时，若提名者为镇民，则该提名者立即被处决。',
      infoSource: 'none',  // 触发类技能，说书人确认条件
      firstNightOnly: false,
    },
    {
      id: 'slayer',
      name: 'Slayer',
      nameZh: '杀手',
      alignment: 'good',
      type: 'townsfolk',
      ability: 'Once per game, during the day, publicly choose a player: if they are the Demon, they die.',
      abilityZh: '每局一次，白天公开选择一名玩家：若其为恶魔，该玩家死亡。',
      infoSource: 'none',  // 引擎判定：目标是恶魔则死亡
    },
    {
      id: 'soldier',
      name: 'Soldier',
      nameZh: '士兵',
      alignment: 'good',
      type: 'townsfolk',
      ability: 'You are safe from the Demon.',
      abilityZh: '你免疫恶魔的杀害。',
      infoSource: 'none',  // 被动免疫
    },
    {
      id: 'mayor',
      name: 'Mayor',
      nameZh: '市长',
      alignment: 'good',
      type: 'townsfolk',
      ability: 'If only 3 players live & no execution occurs today, your team wins. If you die at night, another player might die instead.',
      abilityZh: '若仅剩3名存活玩家且本日无人被处决，善良阵营获胜。若你在夜晚死亡，可能有其他玩家替死。',
      infoSource: 'none',  // 被动效果，替死由说书人决定
    },

    // ============ 外来者 (Outsider) ============
    {
      id: 'drunk',
      name: 'Drunk',
      nameZh: '酒鬼',
      alignment: 'good',
      type: 'outsider',
      ability: 'You do not know you are the Drunk. You think you are a Townsfolk character, but you are not.',
      abilityZh: '你不知道自己是酒鬼。你以为自己是一个镇民角色，但实际上不是。',
      infoSource: 'storyteller',  // 说书人编造所有信息
    },
    {
      id: 'recluse',
      name: 'Recluse',
      nameZh: '隐士',
      alignment: 'good',
      type: 'outsider',
      ability: 'You might register as evil & as a Minion or Demon for abilities.',
      abilityZh: '你可能被能力检测为邪恶阵营、爪牙或恶魔（由说书人决定）。',
      infoSource: 'storyteller',  // 说书人决定隐士如何被能力感知
    },
    {
      id: 'saint',
      name: 'Saint',
      nameZh: '圣徒',
      alignment: 'good',
      type: 'outsider',
      ability: 'If you are executed, your team loses.',
      abilityZh: '若你被处决，善良阵营失败。',
      infoSource: 'none',  // 被动胜负条件
    },
    {
      id: 'butler',
      name: 'Butler',
      nameZh: '管家',
      alignment: 'good',
      type: 'outsider',
      ability: 'Each night, choose a player (not yourself): tomorrow, you may only vote if they are voting too.',
      abilityZh: '每夜选择一名玩家（不能选自己）：次日仅当该玩家投票时，你才能投票。',
      infoSource: 'none',
      requiresPlayerChoice: true,
      pickCount: 1,
    },

    // ============ 爪牙 (Minions) ============
    {
      id: 'poisoner',
      name: 'Poisoner',
      nameZh: '投毒者',
      alignment: 'evil',
      type: 'minion',
      ability: 'Each night, choose a player: they are poisoned tonight and all day tomorrow. They yield false info & their ability malfunctions.',
      abilityZh: '每夜选择一名玩家：该玩家当夜和次日白天中毒。中毒者获得错误信息且能力失效。',
      infoSource: 'none',
      requiresPlayerChoice: true,
      pickCount: 1,
    },
    {
      id: 'spy',
      name: 'Spy',
      nameZh: '间谍',
      alignment: 'evil',
      type: 'minion',
      ability: 'Each night, you see the Grimoire. You might register as good & as a Townsfolk or Outsider for abilities.',
      abilityZh: '每夜你查看魔典（全场角色分配）。你可能被能力检测为善良阵营、镇民或外来者。',
      infoSource: 'storyteller',  // 看魔典是说书人给的；如何被感知也是说书人决定
    },
    {
      id: 'baron',
      name: 'Baron',
      nameZh: '男爵',
      alignment: 'evil',
      type: 'minion',
      ability: 'There are 2 extra Outsiders in play. [+2 Outsiders]',
      abilityZh: '本局额外有两名外来者在场。[+2 外来者]',
      infoSource: 'none',  // 被动影响角色池分配
    },
    {
      id: 'scarlet_woman',
      name: 'Scarlet Woman',
      nameZh: '猩红女巫',
      alignment: 'evil',
      type: 'minion',
      ability: 'If there are 5 or more players alive & the Demon dies, you become the Demon. (Travellers count.)',
      abilityZh: '若存活玩家≥5且恶魔死亡，你变为恶魔。',
      infoSource: 'none',  // 被动触发
    },

    // ============ 恶魔 (Demon) ============
    {
      id: 'imp',
      name: 'Imp',
      nameZh: '小恶魔',
      alignment: 'evil',
      type: 'demon',
      ability: 'Each night*, choose a player: they die. If you choose yourself, a Minion becomes the Imp.',
      abilityZh: '每夜*选择一名玩家：该玩家死亡。若你选择自己死亡，一名爪牙变为小恶魔。',
      infoSource: 'none',
      requiresPlayerChoice: true,
      pickCount: 1,
    },
  ],
};
