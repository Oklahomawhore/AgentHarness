/** Development workbench UI dictionaries. */

export const NS = 'devWorkbench'

/** Simplified Chinese messages. */
export const zh = {
  'trigger.label': '开发工作台',
  'trigger.aria': '打开开发工作台',
  'panel.title': '开发工作台',
  'panel.subtitle': '任务、日志与调试页面由 Harness 统一管理',
  'panel.close': '关闭工作台',
  'panel.empty': '尚未配置开发任务',
  'panel.loading': '正在读取开发任务…',
  'panel.readFailed': '读取失败：{message}',
  'panel.pickView': '选择一个调试页面',
  'panel.noView': '该任务没有配置调试页面；可在下方查看运行日志。',
  'panel.resize': '拖动左下角调整工作台大小',
  'action.start': '启动',
  'action.restart': '重新启动',
  'action.stop': '停止',
  'action.refresh': '刷新',
  'action.open': '新窗口打开',
  'status.idle': '待启动',
  'status.running': '运行中',
  'status.stopping': '停止中',
  'status.stopped': '已停止',
  'status.exited': '已退出',
  'status.failed': '启动失败',
  'readiness.checking': '等待页面就绪',
  'readiness.ready': '页面已就绪',
  'readiness.delayed': '页面就绪延迟',
  'readiness.waiting': 'Harness 正在探测配置的页面地址…',
  'logs.title': '运行日志',
  'logs.empty': '暂无输出',
  'logs.stdout': 'stdout',
  'logs.stderr': 'stderr',
  'logs.lossy': '较早输出已被有界缓冲区丢弃',
} satisfies Record<string, string>

/** Translation keys owned by this package. */
export type DevWorkbenchKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Development workbench copy. */
    devWorkbench: DevWorkbenchKey
  }
}

/** English messages. */
export const en = {
  'trigger.label': 'Dev Workbench',
  'trigger.aria': 'Open development workbench',
  'panel.title': 'Development workbench',
  'panel.subtitle': 'Harness-managed tasks, logs, and debug pages',
  'panel.close': 'Close workbench',
  'panel.empty': 'No development tasks configured',
  'panel.loading': 'Reading development tasks…',
  'panel.readFailed': 'Read failed: {message}',
  'panel.pickView': 'Choose a debug page',
  'panel.noView': 'This task has no debug page; its process output remains available below.',
  'panel.resize': 'Drag the lower-left corner to resize the workbench',
  'action.start': 'Start',
  'action.restart': 'Restart',
  'action.stop': 'Stop',
  'action.refresh': 'Refresh',
  'action.open': 'Open in new window',
  'status.idle': 'Ready',
  'status.running': 'Running',
  'status.stopping': 'Stopping',
  'status.stopped': 'Stopped',
  'status.exited': 'Exited',
  'status.failed': 'Failed',
  'readiness.checking': 'Waiting for page',
  'readiness.ready': 'Page ready',
  'readiness.delayed': 'Page delayed',
  'readiness.waiting': 'Harness is probing the configured page URL…',
  'logs.title': 'Process output',
  'logs.empty': 'No output yet',
  'logs.stdout': 'stdout',
  'logs.stderr': 'stderr',
  'logs.lossy': 'Earlier output was dropped by the bounded buffer',
} satisfies Record<DevWorkbenchKey, string>
