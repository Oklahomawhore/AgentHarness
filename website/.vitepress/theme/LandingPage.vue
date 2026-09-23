<script setup lang="ts">
import { computed, ref } from 'vue'
import { withBase } from 'vitepress'

const props = defineProps<{ locale: 'zh' | 'en' }>()

const translations = {
  zh: {
    nav: [
      { label: '如何协作', href: '#zero' },
      { label: '共享上下文', href: '#memory' },
      { label: '由人决定', href: '#loop' },
    ],
    docs: '阅读文档',
    eyebrow: 'AGENTHARNESS / TASK COLLABORATION',
    titleStart: '一份任务。',
    titleAccent: '多位 Agent。',
    titleEnd: '清楚的上下文。',
    intro: '创建 Task，让各个 Agent Session 主动加入。只发布需要共享的决策与依据，让后来者知道从哪里继续。',
    primary: '了解协作方式',
    status: 'TASK / CONTEXT / AGENT SESSIONS',
    zero: {
      label: 'PRIMARY PRODUCT FLOW / 00',
      metricLabel: '段私聊自动发布',
      heading: '同一份 Task 上下文，\n由参与者主动维护。',
      body: '每位参与者保留自己的工作方式。Agent Session 明确加入 Task；结论和来源在有人选择发布后才进入共享上下文。',
      stage: 'TASK COLLABORATION',
      state: 'ILLUSTRATIVE FLOW',
      people: [
        { id: '01', name: 'MIRA', activity: '喝咖啡', role: 'PRODUCT', scene: 'coffee' },
        { id: '02', name: 'KAI', activity: '打游戏', role: 'ENGINEERING', scene: 'gaming' },
        { id: '03', name: 'SOL', activity: '在工作', role: 'RESEARCH', scene: 'working' },
        { id: '04', name: 'NOA', activity: '读一本书', role: 'DESIGN', scene: 'reading' },
        { id: '05', name: 'LEO', activity: '听音乐', role: 'GROWTH', scene: 'music' },
        { id: '06', name: 'AYA', activity: '晒太阳', role: 'OPERATIONS', scene: 'resting' },
      ],
      rails: ['6 HUMANS', '6 PERSONAL AGENTS', '1 SHARED STATE'],
      caption: '不同 Session 可以围绕同一个 Task 工作，私人对话不会自动进入共享上下文。',
    },
    manifestoLabel: 'COLLABORATION, AS A LIVING SYSTEM',
    manifestoTitle: '少一点重复解释。\n多一点可追溯的进展。',
    manifestoBody: 'AgentHarness 让 Task 保留主动发布的上下文。后来加入的 Session 可以看到任务目标、来源和已有结论，再由人决定下一步。',
    room: {
      number: '01',
      overline: 'LIVE COLLABORATION ROOM',
      heading: '所有参与者，\n共享同一个「现在」。',
      body: '人和 Agent 同时进入一个任务现场。进展、分工、问题与决策实时可见；没有上下文转述，也不再等待交接。',
      note: '4 个协作者 · 1 份实时上下文',
      panelTitle: 'Launch room / Product narrative',
      live: 'LIVE',
      activities: [
        { actor: '你', meta: '09:41', text: '把新首页的品牌感放在功能说明之前。' },
        { actor: 'Mira', meta: 'Agent · 09:41', text: '正在统一品牌语言，并保留文档入口。' },
        { actor: 'Scout', meta: 'Agent · 09:42', text: '发现三处叙事可以合并为同一条主线。' },
      ],
      composing: 'Loop 正在整理下一步…',
      members: ['你', 'MI', 'SC', 'LO'],
    },
    memory: {
      number: '02',
      overline: 'SHARED TASK CONTEXT',
      heading: '上下文离开一个窗口，\n仍可留在 Task 中。',
      body: '参与者主动发布任务目标、关键决策和必要来源。新的 Agent Session 可以从已共享的内容继续，而不必读取所有人的私人对话。',
      note: '每一次协作，都让下一次更聪明',
      center: 'TASK\nCONTEXT',
      nodes: ['产品意图', '代码库', '关键决策', '用户反馈', '团队偏好', '运行结果'],
      fact: '持续更新',
      facts: ['可追溯', '可继承', '可共享'],
    },
    loop: {
      number: '03',
      overline: 'HUMAN · AGENT · AGENT · HUMAN',
      heading: '把控制权留给人，\n把可能性交给群体智能。',
      body: '人定义意图，Agent 并行探索与互相校验，结果回到人类判断。不是自动化替代，而是一条更短、更透明、更有复利的合作回路。',
      note: '判断有归属 · 行动可观察 · 结果能修正',
      steps: [
        { index: 'H₁', role: 'HUMAN', verb: '设定意图', detail: '明确目标、边界与品味。' },
        { index: 'A₁', role: 'AGENT 01', verb: '探索与构建', detail: '把意图转化为可运行的工作。' },
        { index: 'A₂', role: 'AGENT 02', verb: '校验与综合', detail: '挑战假设，合并证据与方案。' },
        { index: 'H₂', role: 'HUMAN', verb: '判断与引导', detail: '接受、修正，再开启更好的下一轮。' },
      ],
      loopLabel: 'ONE ACCOUNTABLE LOOP',
    },
    vision: {
      label: 'OUR NORTH STAR',
      prefix: 'Git 让代码拥有共同历史。',
      title: 'Shared context\nfor agent work.',
      body: '让 Task 的目标、决策与来源可协作、可追溯、可派生；发布与使用始终由参与者决定。',
      cta: '进入 AgentHarness',
      footnote: 'BUILT FOR WORK THAT THINKS WITH YOU',
    },
  },
  en: {
    nav: [
      { label: 'How it works', href: '#zero' },
      { label: 'Shared context', href: '#memory' },
      { label: 'Human choice', href: '#loop' },
    ],
    docs: 'Read the docs',
    eyebrow: 'AGENTHARNESS / TASK COLLABORATION',
    titleStart: 'One task.',
    titleAccent: 'Many agents.',
    titleEnd: 'Clear context.',
    intro: 'Create a Task and let Agent sessions join explicitly. Publish only the decisions and sources that collaborators need to continue.',
    primary: 'See how it works',
    status: 'TASK / CONTEXT / AGENT SESSIONS',
    zero: {
      label: 'PRIMARY PRODUCT FLOW / 00',
      metricLabel: 'private chats shared automatically',
      heading: 'One Task context,\nmaintained by its participants.',
      body: 'People keep their own tools and workflows. Agent sessions join a Task explicitly; decisions and sources enter shared context only when someone chooses to publish them.',
      stage: 'TASK COLLABORATION',
      state: 'ILLUSTRATIVE FLOW',
      people: [
        { id: '01', name: 'MIRA', activity: 'COFFEE BREAK', role: 'PRODUCT', scene: 'coffee' },
        { id: '02', name: 'KAI', activity: 'PLAYING A GAME', role: 'ENGINEERING', scene: 'gaming' },
        { id: '03', name: 'SOL', activity: 'DEEP WORK', role: 'RESEARCH', scene: 'working' },
        { id: '04', name: 'NOA', activity: 'READING', role: 'DESIGN', scene: 'reading' },
        { id: '05', name: 'LEO', activity: 'LISTENING', role: 'GROWTH', scene: 'music' },
        { id: '06', name: 'AYA', activity: 'IN THE SUN', role: 'OPERATIONS', scene: 'resting' },
      ],
      rails: ['6 HUMANS', '6 PERSONAL AGENTS', '1 SHARED STATE'],
      caption: 'Separate sessions can work around one Task without publishing private conversations automatically.',
    },
    manifestoLabel: 'COLLABORATION, AS A LIVING SYSTEM',
    manifestoTitle: 'Less repeated explanation.\nMore traceable progress.',
    manifestoBody: 'AgentHarness keeps deliberately published context with a Task. A new session can see its objective, sources, and decisions, while people decide what happens next.',
    room: {
      number: '01',
      overline: 'LIVE COLLABORATION ROOM',
      heading: 'Every participant shares\nthe same now.',
      body: 'People and agents enter the same task space. Progress, ownership, questions, and decisions stay visible in real time—without context relays or handoff delay.',
      note: '4 collaborators · 1 live context',
      panelTitle: 'Launch room / Product narrative',
      live: 'LIVE',
      activities: [
        { actor: 'You', meta: '09:41', text: 'Let the brand lead before we explain the features.' },
        { actor: 'Mira', meta: 'Agent · 09:41', text: 'Unifying the narrative while keeping docs one step away.' },
        { actor: 'Scout', meta: 'Agent · 09:42', text: 'Found three messages that resolve into one story.' },
      ],
      composing: 'Loop is composing the next move…',
      members: ['YOU', 'MI', 'SC', 'LO'],
    },
    memory: {
      number: '02',
      overline: 'SHARED TASK CONTEXT',
      heading: 'Context leaves a window.\nIt can stay with the Task.',
      body: 'Participants publish the objective, key decisions, and relevant sources. New Agent sessions can continue from what was shared without reading everyone’s private chats.',
      note: 'Every collaboration makes the next one smarter',
      center: 'TASK\nCONTEXT',
      nodes: ['Product intent', 'Codebase', 'Key decisions', 'User signals', 'Team taste', 'Run results'],
      fact: 'Always learning',
      facts: ['Traceable', 'Inheritable', 'Shareable'],
    },
    loop: {
      number: '03',
      overline: 'HUMAN · AGENT · AGENT · HUMAN',
      heading: 'Keep judgment human.\nGive possibility to the collective.',
      body: 'A person sets intent. Agents explore in parallel and challenge one another. The work returns to human judgment—not automation as replacement, but a shorter, visible, compounding loop.',
      note: 'Owned judgment · Observable action · Correctable outcomes',
      steps: [
        { index: 'H₁', role: 'HUMAN', verb: 'Set intent', detail: 'Define the objective, boundaries, and taste.' },
        { index: 'A₁', role: 'AGENT 01', verb: 'Explore + build', detail: 'Turn intent into working reality.' },
        { index: 'A₂', role: 'AGENT 02', verb: 'Review + synthesize', detail: 'Challenge assumptions and combine evidence.' },
        { index: 'H₂', role: 'HUMAN', verb: 'Judge + direct', detail: 'Accept, reshape, and begin a better loop.' },
      ],
      loopLabel: 'ONE ACCOUNTABLE LOOP',
    },
    vision: {
      label: 'OUR NORTH STAR',
      prefix: 'Git gave code a shared history.',
      title: 'Shared context\nfor agent work.',
      body: 'Keep a Task’s objective, decisions, and sources collaborative, traceable, and forkable. Participants decide what to publish and use.',
      cta: 'Enter AgentHarness',
      footnote: 'BUILT FOR WORK THAT THINKS WITH YOU',
    },
  },
} as const

const copy = computed(() => translations[props.locale])
const guideLink = computed(() => withBase(props.locale === 'zh' ? '/guide/quickstart' : '/en/guide/quickstart'))
const homeLink = computed(() => withBase(props.locale === 'zh' ? '/' : '/en/'))
const alternateLink = computed(() => withBase(props.locale === 'zh' ? '/en/' : '/'))
const activeLoopStep = ref(0)
const hero = ref<HTMLElement | null>(null)

function moveAtmosphere(event: PointerEvent): void {
  if (hero.value === null || event.pointerType === 'touch') return
  const bounds = hero.value.getBoundingClientRect()
  hero.value.style.setProperty('--agentharness-x', `${((event.clientX - bounds.left) / bounds.width - 0.5) * 18}px`)
  hero.value.style.setProperty('--agentharness-y', `${((event.clientY - bounds.top) / bounds.height - 0.5) * 18}px`)
}
</script>

<template>
  <div class="agentharness-site">
    <header class="agentharness-nav">
      <a class="agentharness-brand" :href="homeLink" aria-label="AgentHarness home">
        <span class="agentharness-brand-mark">AH</span>
        <span class="agentharness-brand-name">AgentHarness</span>
      </a>
      <nav class="agentharness-nav-links" :aria-label="locale === 'zh' ? '主页导航' : 'Home navigation'">
        <a v-for="item in copy.nav" :key="item.href" :href="item.href">{{ item.label }}</a>
      </nav>
      <div class="agentharness-nav-end">
        <a class="agentharness-language" :href="alternateLink">{{ locale === 'zh' ? 'EN' : '中文' }}</a>
        <a class="agentharness-nav-action" :href="guideLink">{{ copy.docs }} <span aria-hidden="true">↗</span></a>
      </div>
    </header>

    <main>
      <section ref="hero" class="agentharness-hero" @pointermove="moveAtmosphere">
        <div class="agentharness-hero-copy">
          <p class="agentharness-eyebrow"><span />{{ copy.eyebrow }}</p>
          <h1>{{ copy.titleStart }}<em>{{ copy.titleAccent }}</em>{{ copy.titleEnd }}</h1>
          <p class="agentharness-intro">{{ copy.intro }}</p>
          <div class="agentharness-actions">
            <a class="agentharness-button agentharness-button-primary" href="#zero">{{ copy.primary }} <span aria-hidden="true">↓</span></a>
            <a class="agentharness-button agentharness-button-quiet" :href="guideLink">{{ copy.docs }} <span aria-hidden="true">↗</span></a>
          </div>
        </div>
        <div class="agentharness-hero-object">
          <img :src="withBase('/agentharness-hero.png')" :alt="locale === 'zh' ? '人和多个 Agent 围绕共享任务协作' : 'People and agents collaborating around a shared task'">
        </div>
        <p class="agentharness-status">{{ copy.status }}</p>
      </section>

      <section id="zero" class="agentharness-zero">
        <div class="agentharness-zero-copy">
          <p class="agentharness-section-label">{{ copy.zero.label }}</p>
          <div class="agentharness-zero-metric"><strong>0</strong><span>{{ copy.zero.metricLabel }}</span></div>
          <h2>{{ copy.zero.heading }}</h2>
          <p>{{ copy.zero.body }}</p>
        </div>
        <div class="agentharness-zero-console">
          <div class="agentharness-zero-console-head">
            <span>{{ copy.zero.stage }}</span>
            <strong><i />{{ copy.zero.state }}</strong>
          </div>
          <div class="agentharness-zero-network" aria-hidden="true">
            <div class="agentharness-zero-mesh" />
            <div v-for="(person, index) in copy.zero.people" :key="`spoke-${person.id}`" :class="['agentharness-star-spoke', `agentharness-star-spoke-${index}`]">
              <i class="agentharness-star-signal agentharness-star-signal-out" />
              <i class="agentharness-star-signal agentharness-star-signal-in" />
              <span class="agentharness-star-agent"><i /><b>A{{ person.id }}</b></span>
            </div>
            <div v-for="(person, index) in copy.zero.people" :key="person.id" :class="['agentharness-human-node', `agentharness-human-node-${index}`]">
              <div class="agentharness-person-scene">
                <div :class="['agentharness-person-model', `agentharness-person-${person.scene}`]">
                  <i class="agentharness-person-shadow" />
                  <span class="agentharness-person-head"><i /><b /></span>
                  <span class="agentharness-person-neck" />
                  <span class="agentharness-person-torso" />
                  <span class="agentharness-person-arm agentharness-person-arm-left"><i /></span>
                  <span class="agentharness-person-arm agentharness-person-arm-right"><i /></span>
                  <span class="agentharness-person-leg agentharness-person-leg-left"><i /></span>
                  <span class="agentharness-person-leg agentharness-person-leg-right"><i /></span>
                  <span class="agentharness-person-prop"><i /><b /><em /></span>
                </div>
              </div>
              <div class="agentharness-human-label"><small>H{{ person.id }} · {{ person.role }}</small><strong>{{ person.name }} / {{ person.activity }}</strong></div>
            </div>
            <div class="agentharness-star-harness">
              <i class="agentharness-star-ring agentharness-star-ring-a" />
              <i class="agentharness-star-ring agentharness-star-ring-b" />
              <span>AgentHarness</span>
              <strong>HARNESS</strong>
              <small>SHARED STATE</small>
            </div>
          </div>
          <div class="agentharness-zero-console-foot">
            <span v-for="rail in copy.zero.rails" :key="rail"><i />{{ rail }}</span>
          </div>
        </div>
        <p class="agentharness-zero-caption"><span>00</span>{{ copy.zero.caption }}</p>
      </section>

      <section class="agentharness-manifesto">
        <p class="agentharness-section-label">{{ copy.manifestoLabel }}</p>
        <h2>{{ copy.manifestoTitle }}</h2>
        <p>{{ copy.manifestoBody }}</p>
      </section>

      <section id="room" class="agentharness-feature agentharness-feature-room">
        <div class="agentharness-feature-copy">
          <div class="agentharness-feature-index"><span>{{ copy.room.number }}</span><i /></div>
          <p class="agentharness-overline">{{ copy.room.overline }}</p>
          <h2>{{ copy.room.heading }}</h2>
          <p class="agentharness-feature-body">{{ copy.room.body }}</p>
          <p class="agentharness-feature-note"><span />{{ copy.room.note }}</p>
        </div>
        <div class="agentharness-room-frame">
          <div class="agentharness-frame-top">
            <div><i /><i /><i /></div>
            <span>{{ copy.room.panelTitle }}</span>
            <strong><i /> {{ copy.room.live }}</strong>
          </div>
          <div class="agentharness-room-main">
            <aside class="agentharness-member-rail" aria-hidden="true">
              <span v-for="(member, index) in copy.room.members" :key="member" :class="`agentharness-avatar agentharness-avatar-${index}`">{{ member }}</span>
              <i />
              <small>04</small>
            </aside>
            <div class="agentharness-room-stream">
              <div v-for="(activity, index) in copy.room.activities" :key="activity.actor" class="agentharness-message">
                <span :class="`agentharness-avatar agentharness-avatar-${index}`">{{ copy.room.members[index] }}</span>
                <div>
                  <p><strong>{{ activity.actor }}</strong><small>{{ activity.meta }}</small></p>
                  <span>{{ activity.text }}</span>
                </div>
              </div>
              <div class="agentharness-composing"><i /><i /><i /> {{ copy.room.composing }}</div>
            </div>
          </div>
          <div class="agentharness-frame-foot"><span>CONTEXT SYNCED</span><span>ROOM 7F-2A</span></div>
        </div>
      </section>

      <section id="memory" class="agentharness-feature agentharness-feature-memory">
        <div class="agentharness-memory-map" aria-hidden="true">
          <div class="agentharness-memory-halo agentharness-memory-halo-a" />
          <div class="agentharness-memory-halo agentharness-memory-halo-b" />
          <div class="agentharness-memory-center"><span>{{ copy.memory.center }}</span><i /></div>
          <span v-for="(node, index) in copy.memory.nodes" :key="node" :class="`agentharness-memory-node agentharness-memory-node-${index}`"><i />{{ node }}</span>
          <div class="agentharness-memory-facts">
            <strong>{{ copy.memory.fact }}</strong>
            <span v-for="fact in copy.memory.facts" :key="fact">{{ fact }}</span>
          </div>
        </div>
        <div class="agentharness-feature-copy">
          <div class="agentharness-feature-index"><span>{{ copy.memory.number }}</span><i /></div>
          <p class="agentharness-overline">{{ copy.memory.overline }}</p>
          <h2>{{ copy.memory.heading }}</h2>
          <p class="agentharness-feature-body">{{ copy.memory.body }}</p>
          <p class="agentharness-feature-note"><span />{{ copy.memory.note }}</p>
        </div>
      </section>

      <section id="loop" class="agentharness-feature agentharness-feature-loop">
        <div class="agentharness-feature-copy">
          <div class="agentharness-feature-index"><span>{{ copy.loop.number }}</span><i /></div>
          <p class="agentharness-overline">{{ copy.loop.overline }}</p>
          <h2>{{ copy.loop.heading }}</h2>
          <p class="agentharness-feature-body">{{ copy.loop.body }}</p>
          <p class="agentharness-feature-note"><span />{{ copy.loop.note }}</p>
        </div>
        <div class="agentharness-loop-panel">
          <div class="agentharness-loop-orbit" aria-hidden="true"><i /><i /><span>{{ copy.loop.loopLabel }}</span></div>
          <button
            v-for="(step, index) in copy.loop.steps"
            :key="step.index"
            type="button"
            :class="['agentharness-loop-step', `agentharness-loop-step-${index}`, { active: activeLoopStep === index }]"
            @mouseenter="activeLoopStep = index"
            @focus="activeLoopStep = index"
            @click="activeLoopStep = index"
          >
            <span>{{ step.index }}</span>
            <small>{{ step.role }}</small>
            <strong>{{ step.verb }}</strong>
          </button>
          <div class="agentharness-loop-detail" aria-live="polite">
            <span>{{ copy.loop.steps[activeLoopStep].index }}</span>
            <p>{{ copy.loop.steps[activeLoopStep].detail }}</p>
          </div>
        </div>
      </section>

      <section class="agentharness-vision">
        <div class="agentharness-vision-wash" aria-hidden="true"><i /><i /><i /></div>
        <p class="agentharness-section-label">{{ copy.vision.label }}</p>
        <p class="agentharness-vision-prefix">{{ copy.vision.prefix }}</p>
        <h2>{{ copy.vision.title }}</h2>
        <p class="agentharness-vision-body">{{ copy.vision.body }}</p>
        <a class="agentharness-vision-cta" :href="guideLink"><span>{{ copy.vision.cta }}</span><i aria-hidden="true">↗</i></a>
        <small>{{ copy.vision.footnote }}</small>
      </section>
    </main>

    <footer class="agentharness-footer">
      <a class="agentharness-brand" :href="homeLink"><span class="agentharness-brand-mark">AgentHarness</span><span class="agentharness-brand-name">HARNESS</span></a>
      <p>© {{ new Date().getFullYear() }} AgentHarness</p>
      <div><a :href="guideLink">{{ copy.docs }}</a><a href="https://github.com/deepseek-ai/deepseek-harness">GitHub ↗</a></div>
    </footer>
  </div>
</template>
