export function renderMcpGuide(root?: string, port?: number): string
export function collaborationBrowserUrl(logPath: string, origin: string): Promise<string>
export function runInstalledCommand(args: string[], environment?: NodeJS.ProcessEnv): Promise<void | boolean>
