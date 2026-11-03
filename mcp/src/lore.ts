// The four-screen introduction that application.FirstLoadScreen plays exactly once,
// right after a new save is created. It is the game's own statement of the rules:
// cold sleep, the AI's 0.78 line, the forced destination, and the compression
// self-destruct that ends a run nobody solved.
//
// Read live from the game's four text areas (`title` / `title2` / `title3` /
// `title4`), so this copy is for orientation - the authoritative one is
// gnosia_areas while the screen is up. Screen 4 is only filled when the crawl
// reaches its last page, which is why the on-disk copy came from a screenshot.

export interface LoreScreen {
  screen: number;
  area: string;
  lines: string[];
}

export const LORE_INTRO: LoreScreen[] = [
  {
    screen: 1,
    area: 'title',
    lines: [
      '当确认到古诺希亚污染之后，',
      '乘客就必须担负起让风险降到零的义务。',
      '通常在星际飞船上被认可有效的办法，',
      '是将有污染嫌疑的人送去冷冻睡眠处理。',
      '这种做法反过来利用了污染者的伪装，',
      '同时也可以避免采用更激进的对策造成集团恐慌。',
      '视乘客情况不同也经常会采取武力镇压方式，',
      '但为防止像亨帕斯事件一样发生悲惨的牺牲乃至自灭，',
      '当人工智能体对计划评分在0.78以下时不应采用这种方法'
    ]
  },
  {
    screen: 2,
    area: 'title2',
    lines: [
      '在采用冷冻睡眠方案的情况下，',
      '首先要告知全体乘客，',
      '需要在每次空间转移前选择污染可能性较高的人，',
      '将其送入冷冻睡眠，以期望将最终风险降为零。',
      '接着就要让乘客们一同进行交流，',
      '决定要将谁送去冷冻睡眠。',
      '在确定到污染的同时，',
      '飞船和人工智能体的功能将大幅受限，',
      '所以交流必须面对面通过口头交流来进行。',
      '希望通过这样可以看穿污染者的伪装'
    ]
  },
  {
    screen: 3,
    area: 'title3',
    lines: [
      '此外，在确认到污染的同时，',
      '飞船的目的地星系将由人工智能体的判断而改变。',
      '变更地点将会是靠目前舰内资源能够到达的',
      '需要空间转移次数最多的星系。',
      '如果在风险评价降低至零之前到达目标星系，',
      '那么飞船就会进行压缩自爆。',
      '当然，这是为了防止污染在目的地星系扩散。',
      '从毁灭后依旧对全人类留有威胁的阿玛涅吉、汉郸星系来看，',
      '不得不说通过压缩自爆来进行净化，',
      '是一种必不可少的处置手段'
    ]
  },
  {
    screen: 4,
    area: 'title4',
    lines: [
      '风险是否降低到零将在空间转移后进行评定。',
      '该飞船的人工智能体将会通知乘客判定结果。',
      '（目前，所有星际飞船都有实装如下',
      '防范古诺希亚功能的义务：',
      '判定污染等级、强制指定目的地',
      '并强制封锁航路变更，以及压缩自爆等）'
    ]
  }
];

// What those four screens actually mean for play. Kept short on purpose: this is
// the part worth carrying into every loop.
export const LORE_NOTES: string[] = [
  '处理污染者的唯一标准手段是冷冻睡眠（投票 = 送去冷冻），不是处死。',
  '每次空间转移前必须冻结一个人，转移后由 AI 评定风险是否归零；没归零就继续下一轮。',
  '确认污染后飞船与 AI 功能受限，所以只能面对面口头议论 —— 这就是「议论」环节的存在理由。',
  '目的地由 AI 强制指定，故意选「舰内资源够得着、但需要转移次数最多」的星系，用来拖时间。',
  '在风险归零前抵达目标星系 = 飞船压缩自爆，全灭。拖到那一步就是输。',
  '设定上所有星际飞船都强制装有：判定污染等级、强制指定目的地、封锁航路变更、压缩自爆。',
  '前例：亨帕斯事件（集体恐慌导致牺牲乃至自灭）；危险星系：阿玛涅吉、汉郸。',
  'AI 对方案评分低于 0.78 时不应采用武力镇压。'
];
